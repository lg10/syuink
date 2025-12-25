pub mod broadcast;
pub mod signaling;
pub mod gateway;
pub mod route_manager;
pub mod socks5;
pub mod p2p;


use std::net::{Ipv4Addr, SocketAddr, IpAddr};

use tun_device::TunDevice;
use broadcast::BroadcastReflector;
use signaling::{SignalingClient, SignalMessage, ServiceDecl};
use gateway::GatewayRouter;
use route_manager::RouteManager;
use socks5::{Socks5Server, SocksMsg};
use anyhow::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{info, error, warn};
use uuid::Uuid;

use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use etherparse::{Ipv4HeaderSlice, PacketBuilder};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub ip: String,
    pub public_addr: Option<String>,
    pub p2p_port: u16,
    pub name: String,
    pub os: Option<String>,
    pub version: Option<String>,
    pub device_type: Option<String>,
    pub is_gateway: bool,
    pub connected_at: Option<u64>,
    pub route_status: String,
}

pub enum NodeCommand {
    UpdateServices(Vec<ServiceDecl>),
}

pub struct P2PNode {
    virtual_ip: Ipv4Addr,
    netmask: Ipv4Addr,
    device_name: String,
}

impl P2PNode {
    pub fn new(virtual_ip: Ipv4Addr, netmask: Ipv4Addr, device_name: String) -> Self {
        Self {
            virtual_ip,
            netmask,
            device_name,
        }
    }

    pub fn init_tun(&self) -> Result<(Ipv4Addr, TunDevice)> {
        let mut current_ip = self.virtual_ip;
        let mut retry_count = 0;
        let max_retries = 20;

        loop {
            info!("Attempting to create TUN device with IP: {}", current_ip);
            match TunDevice::create(current_ip, self.netmask) {
                Ok(dev) => {
                    info!("Successfully created TUN device on {}", current_ip);
                    return Ok((current_ip, dev));
                }
                Err(e) => {
                    retry_count += 1;
                    if retry_count >= max_retries {
                        return Err(e);
                    }
                    
                    error!("Failed to create TUN on {}: {}. Retrying with next IP...", current_ip, e);
                    
                    let mut octets = current_ip.octets();
                    octets[3] = octets[3].wrapping_add(1);
                    if octets[3] == 0 || octets[3] == 255 {
                          octets[3] = 1;
                    }
                    current_ip = Ipv4Addr::from(octets);
                }
            }
        }
    }

    pub async fn start(
        self, 
        mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
        ip_report_tx: Option<tokio::sync::mpsc::Sender<(String, u16)>>,
        peer_update_tx: Option<tokio::sync::mpsc::Sender<Vec<PeerInfo>>>,
        signaling_url: String,
        token: Option<String>,
        my_id: String,
        my_meta: (Option<String>, Option<String>, Option<String>, bool),
        my_services: Vec<ServiceDecl>,
        mut command_rx: tokio::sync::mpsc::Receiver<NodeCommand>,
    ) -> Result<(String, u16)> {
        // 1. Setup TUN
        let (current_ip, tun) = self.init_tun()?;
        let allocated_ip = current_ip.to_string();
        
        let (mut tun_reader, tun_writer) = tun.split();
        let tun_writer = std::sync::Arc::new(tokio::sync::Mutex::new(tun_writer));
        
        // Initialize Gateway Router if we are a gateway OR have services declared
        let gateway = if my_meta.3 || !my_services.is_empty() {
            info!("Initializing Gateway Router (NAT)...");
            Some(GatewayRouter::new(tun_writer.clone()))
        } else {
            None
        };
        
        // 6. Setup P2P Manager
        let (p2p_event_tx, mut p2p_event_rx) = tokio::sync::mpsc::channel(32);
        let p2p_manager = Arc::new(p2p::P2PManager::new(0, tun_writer.clone(), p2p_event_tx, my_id.clone())?); // Listen on random UDP port
        let p2p_port = p2p_manager.local_port();


        // 2. Setup Broadcast Reflector

        let reflector = BroadcastReflector::new().await?;
        let (broadcast_tx, mut broadcast_rx) = tokio::sync::mpsc::channel(100);
        let reflector_clone = std::sync::Arc::new(reflector);
        let reflector_listener = reflector_clone.clone();
        tokio::spawn(async move {
            reflector_listener.listen_loop(broadcast_tx).await;
        });

        // 3. Setup Signaling
        // Use provided my_id instead of generating new one
        let (signal_tx, mut signal_rx) = tokio::sync::mpsc::channel(32);
        
        info!("Connecting to Signaling Server: {}", signaling_url);
        let group_id = token.clone().unwrap_or_else(|| "default-group".to_string());
        
        let signal_client = match SignalingClient::connect(
            &signaling_url,
            &group_id,
            token,
            my_id.clone(),
            allocated_ip.clone(),
            self.device_name.clone(),
            p2p_port,
            my_meta,
            signal_tx,
        ).await {
            Ok(client) => {
                info!("Signaling connected successfully!");
                if !my_services.is_empty() {
                    let _ = client.send(SignalMessage::RegisterServices {
                        id: my_id.clone(),
                        services: my_services,
                    }).await;
                }
                Some(client)
            },
            Err(e) => {
                error!("Failed to connect to signaling server: {}", e);
                None
            }
        };

        info!("Network interfaces initialized. Running on {}", allocated_ip);

        // 4. Setup SOCKS5 & Route Table
        // Route Table (Target IP -> Peer ID)
        let mut routes: HashMap<Ipv4Addr, String> = HashMap::new();
        // Shared Route Table for SOCKS5
        let shared_routes = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        
        // Incoming TCP Streams (Target Side): (SourcePeerID, StreamID) -> Sender<Data>
        let mut incoming_tcp: HashMap<(String, u32), tokio::sync::mpsc::Sender<Vec<u8>>> = HashMap::new();

        // Try to start SOCKS5 server, fallback to random port if 1080 is taken
        let (socks5_server, socks5_port) = match Socks5Server::new(1080).await {
            Ok((s, p)) => (Arc::new(s), p),
            Err(_) => {
                warn!("Port 1080 is taken, trying to allocate a random port for SOCKS5...");
                match Socks5Server::new(0).await {
                    Ok((s, p)) => (Arc::new(s), p),
                    Err(e) => {
                        error!("Failed to start SOCKS5 server even on random port: {}", e);
                        return Err(anyhow::anyhow!("SOCKS5 Server init failed: {}", e));
                    }
                }
            }
        };

        // Send Initial IP Report with Port
        if let Some(tx) = ip_report_tx {
            let _ = tx.send((allocated_ip.clone(), socks5_port)).await;
        }

        // 5. Main Event Loop
        let mut buf = [0u8; 4096];
        let mut peers: HashMap<String, PeerInfo> = HashMap::new();

        let mut route_manager = RouteManager::new(allocated_ip.clone());
        
        // Track background tasks to abort them on shutdown


        let mut background_tasks = Vec::new();

        
        if let Some(client) = &signal_client {
             let s = socks5_server.clone();
             let c = Arc::new(client.clone());
             let m = my_id.clone();
             let r = shared_routes.clone();
             let task = tokio::spawn(async move {
                 s.run(c, m, r).await;
             });
             background_tasks.push(task);
        }

        loop {
            tokio::select! {
                // Handle Shutdown Signal
                msg = shutdown_rx.recv() => {
                    match msg {
                        Ok(_) => {
                            info!("Shutdown signal received. Stopping VPN node...");
                            for task in background_tasks {
                                task.abort();
                            }
                            route_manager.cleanup();
                            break Ok((allocated_ip, socks5_port));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            info!("Shutdown channel closed. Stopping VPN node...");
                            for task in background_tasks {
                                task.abort();
                            }
                            route_manager.cleanup();
                            break Ok((allocated_ip, socks5_port));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!("Shutdown channel lagged by {}. Continuing...", n);
                        }
                    }
                }

                // Handle External Commands
                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        NodeCommand::UpdateServices(decls) => {
                             info!("Updating services: {} entries", decls.len());
                             if let Some(client) = &signal_client {
                                 let _ = client.send(SignalMessage::RegisterServices {
                                     id: my_id.clone(),
                                     services: decls,
                                 }).await;
                             }
                        }
                    }
                }

                // Handle Signaling Messages
                Some(msg) = signal_rx.recv() => {
                    match msg {
                        SignalMessage::PeerJoined { id, ip, public_addr, p2p_port, name, os, version, device_type, is_gateway, connected_at } => {
                            info!("New Peer Joined: {} ({}) - {} [Public: {:?}:{}]", name, ip, id, public_addr, p2p_port);
                            
                            // Try P2P connection if public address and port are available
                            if let (Some(ref pa), port) = (&public_addr, p2p_port) {
                                if port > 0 && pa != "unknown" {
                                    if let Ok(ip_addr) = pa.parse::<IpAddr>() {
                                        let addr = SocketAddr::new(ip_addr, port);
                                        info!("Attempting P2P connection to {} at {}", name, addr);
                                        let pm = p2p_manager.clone();
                                        let pid = id.clone();
                                        let pname = name.clone();
                                        tokio::spawn(async move {
                                            if let Err(e) = pm.connect_to(pid.clone(), addr).await {
                                                warn!("P2P connection failed to {} ({}): {}", pname, pid, e);
                                            }
                                        });
                                    } else {
                                        warn!("Failed to parse public address: {}", pa);
                                    }
                                } else {
                                    info!("P2P not available for {}: public_addr={:?}, port={}", name, pa, port);
                                }
                            }


                            let existing_status = peers.get(&id).map(|p| p.route_status.clone()).unwrap_or_else(|| "relay".to_string());

                            if let Some(ref tx) = peer_update_tx {
                                let mut list: Vec<PeerInfo> = peers.values().cloned().collect();
                                // Ensure the list includes newly joined peer if not yet in map
                                if !peers.contains_key(&id) {
                                     list.push(PeerInfo { 
                                         id: id.clone(), 
                                         ip: ip.clone(), 
                                         public_addr: public_addr.clone(),
                                         p2p_port,
                                         name: name.clone(), 
                                         os: os.clone(), 
                                         version: version.clone(), 
                                         device_type: device_type.clone(), 
                                         is_gateway, 
                                         connected_at,
                                         route_status: existing_status.clone(),
                                     });
                                }
                                let _ = tx.send(list).await;
                            }
                            
                            peers.insert(id.clone(), PeerInfo { 
                                id, 
                                ip, 
                                public_addr,
                                p2p_port,
                                name,
                                os,
                                version,
                                device_type,
                                is_gateway,
                                connected_at,
                                route_status: existing_status,
                            });



                        }
                        SignalMessage::PeerLeft { id } => {
                            info!("Peer Left: {}", id);
                            peers.remove(&id);
                            
                            if let Some(ref tx) = peer_update_tx {
                                let list: Vec<PeerInfo> = peers.values().cloned().collect();
                                let _ = tx.send(list).await;
                            }
                        }
                        SignalMessage::ServiceUpdate { services } => {
                             info!("Received Service Update: {} entries", services.len());
                             routes.clear();
                             let mut new_ips = Vec::new();
                             for (peer_id, decl) in services {
                                 if let Ok(ip) = decl.ip.parse::<Ipv4Addr>() {
                                     if peer_id == my_id { continue; }
                                     routes.insert(ip, peer_id);
                                     new_ips.push(ip);
                                 }
                             }
                             route_manager.update_routes(&new_ips);
                             
                             // Update shared routes for SOCKS5
                             let mut sr = shared_routes.lock().await;
                             *sr = routes.clone();
                        }
                        SignalMessage::Broadcast { source, data } => {
                            if source == my_id { continue; }
                            if let Ok(raw) = BASE64.decode(&data) {
                                info!("Received Broadcast from {}, writing {} bytes to TUN", source, raw.len());
                                let mut writer = tun_writer.lock().await;
                                let _ = writer.write(&raw).await;
                            }
                        }
                        SignalMessage::TunPacket { source, data, .. } => {
                             if let Ok(raw) = BASE64.decode(&data) {
                                 info!("Received TunPacket from {}, writing {} bytes to TUN", source, raw.len());
                                 let mut writer = tun_writer.lock().await;
                                 let _ = writer.write(&raw).await;
                             }
                        }
                        SignalMessage::TcpConnect { stream_id, source: source_peer, target_ip, target_port, .. } => {
                            info!("Incoming TCP Request from {}: {}:{}", source_peer, target_ip, target_port);
                            if let Some(client) = &signal_client {
                                let client = client.clone();
                                let my_id = my_id.clone();
                                let source_peer = source_peer.clone();
                                let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
                                
                                incoming_tcp.insert((source_peer.clone(), stream_id), tx);
                                
                                tokio::spawn(async move {
                                    match TcpStream::connect(format!("{}:{}", target_ip, target_port)).await {
                                        Ok(socket) => {
                                            let _ = client.send(SignalMessage::TcpConnected {
                                                stream_id,
                                                target: source_peer.clone(),
                                                source: my_id.clone(),
                                                success: true,
                                            }).await;
                                            
                                            let (mut rd, mut wr) = socket.into_split();
                                            
                                            // Pump Local -> Remote
                                            let c = client.clone();
                                            let sp = source_peer.clone();
                                            let mp = my_id.clone();
                                            tokio::spawn(async move {
                                                let mut buf = [0u8; 4096];
                                                loop {
                                                    match rd.read(&mut buf).await {
                                                        Ok(0) => break,
                                                        Ok(n) => {
                                                            let b64 = BASE64.encode(&buf[..n]);
                                                            let _ = c.send(SignalMessage::TcpData {
                                                                stream_id,
                                                                target: sp.clone(),
                                                                source: mp.clone(),
                                                                data: b64,
                                                            }).await;
                                                        }
                                                        Err(_) => break,
                                                    }
                                                }
                                                let _ = c.send(SignalMessage::TcpClose { stream_id, target: sp, source: mp }).await;
                                            });
                                            
                                            // Pump Remote -> Local
                                            while let Some(data) = rx.recv().await {
                                                if wr.write_all(&data).await.is_err() { break; }
                                            }
                                        },
                                        Err(e) => {
                                            error!("Failed to connect local target: {}", e);
                                            let _ = client.send(SignalMessage::TcpConnected {
                                                stream_id,
                                                target: source_peer,
                                                source: my_id,
                                                success: false,
                                            }).await;
                                        }
                                    }
                                });
                            }
                        }
                        SignalMessage::TcpConnected { stream_id, success, .. } => {
                            socks5_server.on_msg(stream_id, SocksMsg::Connected(success)).await;
                        }
                        SignalMessage::TcpData { stream_id, data, source: source_peer, .. } => {
                            if let Ok(bytes) = BASE64.decode(&data) {
                                 // Try Socks5 (Initiator)
                                 socks5_server.on_msg(stream_id, SocksMsg::Data(bytes.clone())).await;
                                 // Try Incoming (Target)
                                 if let Some(tx) = incoming_tcp.get(&(source_peer, stream_id)) {
                                     let _ = tx.send(bytes).await;
                                 }
                            }
                        }
                        SignalMessage::TcpClose { stream_id, source: source_peer, .. } => {
                             socks5_server.on_msg(stream_id, SocksMsg::Closed).await;
                             incoming_tcp.remove(&(source_peer, stream_id));
                        }
                        SignalMessage::Offer { .. } => {
                            info!("Received Offer (P2P negotiation)");
                        }
                        _ => {}
                    }
                }

                // Handle P2P Events
                Some(event) = p2p_event_rx.recv() => {
                    match event {
                        p2p::P2PEvent::Connected(id) => {
                            if let Some(peer) = peers.get_mut(&id) {
                                info!("Peer {} switched to P2P connection", peer.name);
                                peer.route_status = "p2p".to_string();
                                
                                if let Some(ref tx) = peer_update_tx {
                                    let list: Vec<PeerInfo> = peers.values().cloned().collect();
                                    let _ = tx.send(list).await;
                                }
                            }
                        }
                        p2p::P2PEvent::Disconnected(id) => {
                            if let Some(peer) = peers.get_mut(&id) {
                                info!("Peer {} lost P2P connection, falling back to relay", peer.name);
                                peer.route_status = "relay".to_string();
                                
                                if let Some(ref tx) = peer_update_tx {
                                    let list: Vec<PeerInfo> = peers.values().cloned().collect();
                                    let _ = tx.send(list).await;
                                }
                            }
                        }
                    }
                }

                // Read from TUN (Outbound traffic)

                res = tun_reader.read(&mut buf) => {
                    match res {
                        Ok(0) => {
                            error!("TUN device closed (read 0 bytes). Exiting node loop.");
                            for task in background_tasks {
                                task.abort();
                            }
                            route_manager.cleanup();
                            break Ok((allocated_ip, socks5_port));
                        }
                        Ok(n) => {
                            let packet_data = &buf[..n];
                            if let Ok(ipv4) = Ipv4HeaderSlice::from_slice(packet_data) {
                                let dest = ipv4.destination_addr();
                                let dest_ip = std::net::Ipv4Addr::from(dest);
                                
                                let is_vpn_traffic = dest_ip.octets()[0] == 10 && dest_ip.octets()[1] == 10;
                                let is_broadcast = dest_ip.is_broadcast() || dest_ip.is_multicast();
                                
                                let mut handled = false;

                                // 1. Try Unicast routing for VPN internal traffic (10.10.x.x)
                                if is_vpn_traffic && !is_broadcast {
                                    let target_peer = peers.values().find(|p| p.ip == dest_ip.to_string());
                                    if let Some(peer) = target_peer {
                                        let mut sent_p2p = false;
                                        
                                        // Try P2P first
                                        if let Some(conn) = p2p_manager.get_connection(&peer.id).await {
                                            // 1. Try Datagram (fast path)
                                            if let Ok(_) = conn.send_datagram(packet_data.to_vec().into()) {
                                                sent_p2p = true;
                                            } else {
                                                // 2. Fallback to Stream (for large packets or if datagrams are disabled)
                                                match conn.open_uni().await {
                                                    Ok(mut send) => {
                                                        if let Ok(_) = send.write_all(packet_data).await {
                                                            let _ = send.finish().await;
                                                            sent_p2p = true;
                                                        }
                                                    }
                                                    Err(e) => warn!("Failed to open P2P stream to {}: {}", peer.id, e),
                                                }
                                            }
                                        }

                                        if !sent_p2p {
                                            if let Some(client) = &signal_client {
                                                info!("Sending Unicast TunPacket to {} ({}) via Relay", peer.name, peer.ip);
                                                let b64 = BASE64.encode(packet_data);
                                                let _ = client.send(SignalMessage::TunPacket {
                                                    target: peer.id.clone(),
                                                    source: my_id.clone(),
                                                    data: b64,
                                                }).await;
                                                
                                                // Trigger P2P connection attempt if we have a public address
                                                if let (Some(ref pa), port) = (&peer.public_addr, peer.p2p_port) {
                                                    if port > 0 && pa != "unknown" {
                                                        if let Ok(ip_addr) = pa.parse::<IpAddr>() {
                                                            let addr = SocketAddr::new(ip_addr, port);
                                                            let pm = p2p_manager.clone();
                                                            let pid = peer.id.clone();
                                                            tokio::spawn(async move {
                                                                let _ = pm.connect_to(pid, addr).await;
                                                            });
                                                        }
                                                    }
                                                }

                                            }
                                        }
                                        handled = true;
                                    }
                                }

                                // 2. Try routing for external subnets (via gateway/services)
                                if !handled && !is_vpn_traffic && !is_broadcast {
                                    if let Some(target_peer_id) = routes.get(&dest_ip) {
                                         if ipv4.protocol() == etherparse::IpNumber::UDP {
                                             if let Some(client) = &signal_client {
                                                 let b64 = BASE64.encode(packet_data);
                                                 let _ = client.send(SignalMessage::TunPacket {
                                                     target: target_peer_id.clone(),
                                                     source: my_id.clone(),
                                                     data: b64,
                                                 }).await;
                                             }
                                         }
                                         handled = true;
                                    }
                                    
                                    if !handled {
                                        if let Some(gw) = &gateway {
                                            let _ = gw.handle_packet(packet_data).await;
                                            handled = true;
                                        }
                                    }
                                }

                                // 3. Fallback to Broadcast for broadcast/multicast or unknown VPN destinations
                                if !handled && (is_broadcast || is_vpn_traffic) {
                                    if let Some(client) = &signal_client {
                                        let b64 = BASE64.encode(packet_data);
                                        let _ = client.send(SignalMessage::Broadcast {
                                            source: my_id.clone(),
                                            data: b64,
                                        }).await;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("TUN read error: {:?}. Exiting node loop.", e);
                            for task in background_tasks {
                                task.abort();
                            }
                            route_manager.cleanup();
                            break Ok((allocated_ip, socks5_port));
                        }
                    }
                }

                // Read from Broadcast Reflector
                Some((payload, port)) = broadcast_rx.recv() => {
                    let dst_ip = match port {
                        5353 => std::net::Ipv4Addr::new(224, 0, 0, 251),
                        1900 => std::net::Ipv4Addr::new(239, 255, 255, 250),
                        _ => continue,
                    };
                    
                    let src_octets = match allocated_ip.parse::<std::net::Ipv4Addr>() {
                        Ok(ip) => ip.octets(),
                        Err(_) => continue,
                    };
                    let dst_octets = dst_ip.octets();
                    
                    let builder = PacketBuilder::
                        ipv4(src_octets, dst_octets, 20)
                        .udp(port, port);
                        
                    let mut packet = Vec::with_capacity(payload.len() + 64);
                    if let Ok(_) = builder.write(&mut packet, &payload) {
                         if let Some(client) = &signal_client {
                             let b64 = BASE64.encode(&packet);
                             let _ = client.send(SignalMessage::Broadcast {
                                 source: my_id.clone(),
                                 data: b64,
                             }).await;
                         }
                    }
                }
            }
        }
    }
}

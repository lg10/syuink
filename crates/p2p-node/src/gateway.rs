use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use etherparse::{Ipv4HeaderSlice, TcpHeaderSlice, UdpHeaderSlice, IpNumber, PacketBuilder};
use anyhow::Result;
use tracing::{info, error, debug, warn};
use tokio::sync::mpsc::{channel, Sender, Receiver};

// Key for NAT table: (SrcIP, SrcPort, DstIP, DstPort, Protocol)
#[derive(Debug, Hash, Eq, PartialEq, Clone)]
struct FlowKey {
    src_ip: Ipv4Addr,
    src_port: u16,
    dst_ip: Ipv4Addr,
    dst_port: u16,
    protocol: u8, // 6 for TCP, 17 for UDP
}

pub struct GatewayRouter {
    udp_sockets: Arc<Mutex<HashMap<FlowKey, Arc<UdpSocket>>>>,
    tun_writer: Arc<Mutex<tokio::io::WriteHalf<tun_device::AsyncDevice>>>,
    // TCP handling placeholder
    tcp_tx: Sender<Vec<u8>>,
}

impl GatewayRouter {
    pub fn new(tun_writer: Arc<Mutex<tokio::io::WriteHalf<tun_device::AsyncDevice>>>) -> Self {
        let (tcp_tx, mut tcp_rx) = channel(100);
        
        let router = Self {
            udp_sockets: Arc::new(Mutex::new(HashMap::new())),
            tun_writer: tun_writer.clone(),
            tcp_tx,
        };

        // TCP Packet Sink (Placeholder for future TCP NAT)
        tokio::spawn(async move {
            while let Some(_packet) = tcp_rx.recv().await {
                // Drop TCP packets for now.
                // To support TCP direct connection (SSH/HTTP), we need a user-space TCP stack (smoltcp/lwip).
                // Integration with smoltcp proved difficult due to trait bounds on Windows.
                // Current support: UDP (mDNS, SSDP, Games, Voice)
            }
        });

        router
    }

    pub async fn handle_packet(&self, packet: &[u8]) -> Result<()> {
        let ipv4 = match Ipv4HeaderSlice::from_slice(packet) {
            Ok(h) => h,
            Err(_) => return Ok(()),
        };

        let protocol = ipv4.protocol();
        match protocol {
            etherparse::IpNumber::TCP => {
                 let _ = self.tcp_tx.send(packet.to_vec()).await;
                 Ok(())
            },
            etherparse::IpNumber::UDP => self.handle_udp(packet, ipv4).await,
            _ => Ok(()),
        }
    }
    
    async fn handle_udp(&self, packet: &[u8], ipv4: Ipv4HeaderSlice<'_>) -> Result<()> {
        let header_len = ipv4.slice().len();
        let udp_slice = &packet[header_len..];
        let udp = match UdpHeaderSlice::from_slice(udp_slice) {
            Ok(h) => h,
            Err(_) => return Ok(()),
        };

        let src_ip = ipv4.source_addr(); // 10.10.0.x
        let dst_ip = ipv4.destination_addr(); // 192.168.1.x
        let src_port = udp.source_port();
        let dst_port = udp.destination_port();
        let payload = &udp_slice[udp.slice().len()..];

        let key = FlowKey {
            src_ip: src_ip.into(),
            src_port,
            dst_ip: dst_ip.into(),
            dst_port,
            protocol: 17,
        };

        let mut sockets = self.udp_sockets.lock().await;
        
        if let Some(socket) = sockets.get(&key) {
            // Forward payload
            let target = format!("{}:{}", dst_ip, dst_port);
            let _ = socket.send_to(payload, target).await;
        } else {
            // New flow
            info!("New UDP Flow: {}:{} -> {}:{}", src_ip, src_port, dst_ip, dst_port);
            let socket = UdpSocket::bind("0.0.0.0:0").await?;
            let socket = Arc::new(socket);
            
            // Spawn listener for response
            let socket_clone = socket.clone();
            let tun_writer = self.tun_writer.clone();
            let src_ip_fixed = src_ip;
            let src_port_fixed = src_port;

            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match socket_clone.recv_from(&mut buf).await {
                        Ok((n, addr)) => {
                            let src_octets = match addr.ip() {
                                IpAddr::V4(ip) => ip.octets(),
                                _ => continue,
                            };
                            let dst_octets = src_ip_fixed.octets();

                            let builder = PacketBuilder::
                                ipv4(src_octets, dst_octets, 20)
                                .udp(addr.port(), src_port_fixed);

                            let mut result = Vec::<u8>::with_capacity(n + 64);
                            if let Ok(_) = builder.write(&mut result, &buf[..n]) {
                                let mut writer = tun_writer.lock().await;
                                let _ = (&mut *writer).write(&result).await;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            sockets.insert(key, socket.clone());
            let target = format!("{}:{}", dst_ip, dst_port);
            let _ = socket.send_to(payload, target).await;
        }

        Ok(())
    }
}

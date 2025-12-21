use tokio::net::{TcpListener, TcpStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use std::net::{SocketAddr, Ipv4Addr};
use std::sync::Arc;
use tokio::sync::Mutex;
use std::collections::HashMap;
use crate::signaling::{SignalMessage, SignalingClient};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use anyhow::{Result, anyhow};
use tracing::{info, error, debug};

pub enum SocksMsg {
    Connected(bool),
    Data(Vec<u8>),
    Closed,
}

pub struct Socks5Server {
    listener: TcpListener,
    // Map StreamID -> Sender<SocksMsg>
    streams: Arc<Mutex<HashMap<u32, tokio::sync::mpsc::Sender<SocksMsg>>>>,
    next_stream_id: Arc<Mutex<u32>>,
}

impl Socks5Server {
    pub async fn new(preferred_port: u16) -> Result<(Self, u16)> {
        // Try preferred port first
        let listener = match TcpListener::bind(format!("127.0.0.1:{}", preferred_port)).await {
            Ok(l) => l,
            Err(_) => {
                // Fallback to random port
                info!("SOCKS5 port {} occupied, trying random port...", preferred_port);
                TcpListener::bind("127.0.0.1:0").await?
            }
        };
        
        let port = listener.local_addr()?.port();
        info!("SOCKS5 Server listening on 127.0.0.1:{}", port);
        
        Ok((Self {
            listener,
            streams: Arc::new(Mutex::new(HashMap::new())),
            next_stream_id: Arc::new(Mutex::new(1)),
        }, port))
    }

    pub async fn run(
        self: Arc<Self>, 
        signal_client: Arc<SignalingClient>, 
        my_id: String,
        route_table: Arc<Mutex<HashMap<Ipv4Addr, String>>>
    ) {
        loop {
            if let Ok((socket, addr)) = self.listener.accept().await {
                let server = self.clone();
                let client = signal_client.clone();
                let my_id = my_id.clone();
                let routes = route_table.clone();
                
                tokio::spawn(async move {
                    if let Err(e) = server.handle_client(socket, client, my_id, routes).await {
                        debug!("Socks client error {}: {}", addr, e);
                    }
                });
            }
        }
    }
    
    pub async fn on_msg(&self, stream_id: u32, msg: SocksMsg) {
        let mut streams = self.streams.lock().await;
        if let Some(tx) = streams.get(&stream_id) {
            if tx.send(msg).await.is_err() {
                streams.remove(&stream_id);
            }
        } else {
            // Stream not found (maybe closed)
        }
    }

    async fn handle_client(
        &self, 
        mut socket: TcpStream, 
        signal_client: Arc<SignalingClient>,
        my_id: String,
        route_table: Arc<Mutex<HashMap<Ipv4Addr, String>>>
    ) -> Result<()> {
        // 1. Handshake
        let mut buf = [0u8; 2];
        socket.read_exact(&mut buf).await?;
        if buf[0] != 0x05 {
            return Err(anyhow!("Not SOCKS5"));
        }
        let n_methods = buf[1] as usize;
        let mut methods = vec![0u8; n_methods];
        socket.read_exact(&mut methods).await?;
        
        // Respond: No Auth (0x00)
        socket.write_all(&[0x05, 0x00]).await?;

        // 2. Request
        let mut head = [0u8; 4];
        socket.read_exact(&mut head).await?;
        // VER(1) CMD(1) RSV(1) ATYP(1)
        if head[1] != 0x01 { // CONNECT
            return Err(anyhow!("Unsupported command"));
        }

        let target_ip: Ipv4Addr;
        let target_host: String;
        
        match head[3] {
            0x01 => { // IPv4
                let mut ip_buf = [0u8; 4];
                socket.read_exact(&mut ip_buf).await?;
                target_ip = Ipv4Addr::from(ip_buf);
                target_host = target_ip.to_string();
            },
            0x03 => { // Domain
                let mut len_buf = [0u8; 1];
                socket.read_exact(&mut len_buf).await?;
                let len = len_buf[0] as usize;
                let mut host_buf = vec![0u8; len];
                socket.read_exact(&mut host_buf).await?;
                target_host = String::from_utf8_lossy(&host_buf).to_string();
                // Resolve DNS? Or just try to parse as IP
                if let Ok(ip) = target_host.parse::<Ipv4Addr>() {
                    target_ip = ip;
                } else {
                    // Domain resolution not supported yet for route lookup
                    return Err(anyhow!("Domain routing not supported"));
                }
            },
            _ => return Err(anyhow!("Unsupported address type")),
        }

        let mut port_buf = [0u8; 2];
        socket.read_exact(&mut port_buf).await?;
        let port = u16::from_be_bytes(port_buf);

        info!("SOCKS5 Request: {}:{}", target_host, port);

        // 3. Lookup Route
        let target_peer = {
            let routes = route_table.lock().await;
            routes.get(&target_ip).cloned()
        };

        if let Some(peer_id) = target_peer {
            // Found route! Initiate tunnel.
            let stream_id = {
                let mut id = self.next_stream_id.lock().await;
                *id += 1;
                *id
            };

            let (tx, mut rx) = tokio::sync::mpsc::channel(32);
            {
                let mut streams = self.streams.lock().await;
                streams.insert(stream_id, tx);
            }

            // Send TcpConnect
            signal_client.send(SignalMessage::TcpConnect {
                stream_id,
                target: peer_id.clone(),
                source: my_id.clone(),
                target_ip: target_host,
                target_port: port,
            }).await?;

            // Wait for Connected
            match rx.recv().await {
                Some(SocksMsg::Connected(true)) => {
                    // Reply Success
                    socket.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
                },
                _ => {
                    // Fail
                    socket.write_all(&[0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
                    return Err(anyhow!("Connection refused by peer"));
                }
            }

            // Pump Data
            let (mut rd, mut wr) = socket.into_split();
            let my_id_clone = my_id.clone();
            let peer_id_clone = peer_id.clone();
            let client_clone = signal_client.clone();

            // Local -> Remote
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let b64 = BASE64.encode(&buf[..n]);
                            let _ = client_clone.send(SignalMessage::TcpData {
                                stream_id,
                                target: peer_id_clone.clone(),
                                source: my_id_clone.clone(),
                                data: b64,
                            }).await;
                        }
                        Err(_) => break,
                    }
                }
                // Send Close
                let _ = client_clone.send(SignalMessage::TcpClose {
                    stream_id,
                    target: peer_id_clone,
                    source: my_id_clone,
                }).await;
            });

            // Remote -> Local
            while let Some(msg) = rx.recv().await {
                match msg {
                    SocksMsg::Data(data) => {
                        if wr.write_all(&data).await.is_err() {
                            break;
                        }
                    },
                    SocksMsg::Closed => break,
                    _ => {}
                }
            }
            
            // Cleanup
            {
                let mut streams = self.streams.lock().await;
                streams.remove(&stream_id);
            }
        } else {
            // No route found. Reject or Direct?
            // Reject for now.
            socket.write_all(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?; // Network unreachable
        }

        Ok(())
    }
}

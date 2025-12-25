use std::{net::SocketAddr, sync::Arc};
use anyhow::{Result, Context};
use quinn::{Endpoint, Connection};
use tracing::{info, warn};
use tokio::sync::Mutex;
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;


#[derive(Debug, Clone)]
pub enum P2PEvent {
    Connected(String),
    Disconnected(String),
}

pub struct P2PManager {
    endpoint: Endpoint,
    connections: Arc<Mutex<HashMap<String, Connection>>>,
    event_tx: tokio::sync::mpsc::Sender<P2PEvent>,
    my_id: String,
}

impl P2PManager {
    pub fn new(
        bind_port: u16, 
        tun_writer: Arc<tokio::sync::Mutex<tokio::io::WriteHalf<tun_device::AsyncDevice>>>,
        event_tx: tokio::sync::mpsc::Sender<P2PEvent>,
        my_id: String,
    ) -> Result<Self> {
        let (endpoint, _cert) = make_server_endpoint(SocketAddr::from(([0, 0, 0, 0], bind_port)))?;
        let connections = Arc::new(Mutex::new(HashMap::new()));
        
        let endpoint_clone = endpoint.clone();
        let connections_clone = connections.clone();
        let etx = event_tx.clone();
        let tw = tun_writer.clone();
        tokio::spawn(async move {
            Self::accept_loop(endpoint_clone, connections_clone, tw, etx).await;
        });

        info!("QUIC P2P listening on {}", endpoint.local_addr()?);

        Ok(Self {
            endpoint,
            connections,
            event_tx,
            my_id,
        })
    }



    pub fn local_port(&self) -> u16 {
        self.endpoint.local_addr().unwrap().port()
    }

    pub async fn connect_to(&self, peer_id: String, addr: SocketAddr) -> Result<()> {
        {
            let conns = self.connections.lock().await;
            if conns.contains_key(&peer_id) {
                return Ok(());
            }
        }
        
        info!("[P2P] Attempting direct QUIC connection to peer {} at {}", peer_id, addr);
        
        let client_cfg = make_client_config();
        // Set a shorter timeout for P2P attempts to fail fast and fallback to relay
        let conn_res = self.endpoint.connect_with(client_cfg, addr, "syuink-p2p");
        
        let conn = match conn_res {
            Ok(connecting) => {
                match tokio::time::timeout(std::time::Duration::from_secs(5), connecting).await {
                    Ok(Ok(c)) => {
                        info!("[P2P] Successfully established QUIC connection to {}", peer_id);
                        c
                    },
                    Ok(Err(e)) => {
                        warn!("[P2P] QUIC handshake failed to {}: {}. This usually means NAT/Firewall blocked the UDP packet.", peer_id, e);
                        return Err(anyhow::anyhow!("QUIC connection failed: {}", e));
                    }
                    Err(_) => {
                        warn!("[P2P] QUIC connection to {} timed out after 5s. Likely Symmetric NAT or firewall.", peer_id);
                        return Err(anyhow::anyhow!("QUIC connection timeout"));
                    }
                }
            }
            Err(e) => {
                warn!("[P2P] Failed to initiate QUIC connection to {}: {}", peer_id, e);
                return Err(anyhow::anyhow!("QUIC initiation failed: {}", e));
            }
        };
            
        // Handshake: Send our ID
        let mut send = conn.open_uni().await?;
        send.write_all(self.my_id.as_bytes()).await?;
        send.finish().await?;

        info!("P2P handshake sent to {}", peer_id);
        {
            let mut conns = self.connections.lock().await;
            conns.insert(peer_id.clone(), conn.clone());
        }
        
        let _ = self.event_tx.send(P2PEvent::Connected(peer_id.clone())).await;
        
        // Monitor disconnection
        let etx = self.event_tx.clone();
        let pid = peer_id.clone();
        let connections = self.connections.clone();
        tokio::spawn(async move {
            let _ = conn.closed().await;
            info!("P2P connection to {} closed", pid);
            let mut conns = connections.lock().await;
            conns.remove(&pid);
            let _ = etx.send(P2PEvent::Disconnected(pid)).await;
        });

        Ok(())
    }



    pub async fn get_connection(&self, peer_id: &str) -> Option<Connection> {
        let conns = self.connections.lock().await;
        conns.get(peer_id).cloned()
    }

    pub async fn accept_loop(
        endpoint: Endpoint, 
        connections: Arc<Mutex<HashMap<String, Connection>>>, 
        tun_writer: Arc<tokio::sync::Mutex<tokio::io::WriteHalf<tun_device::AsyncDevice>>>,
        event_tx: tokio::sync::mpsc::Sender<P2PEvent>,
    ) {
        info!("[P2P] Accept loop started, waiting for incoming UDP/QUIC connections...");
        while let Some(conn) = endpoint.accept().await {
            let tun_writer = tun_writer.clone();
            let connections = connections.clone();
            let event_tx = event_tx.clone();

            tokio::spawn(async move {
                let remote_addr = conn.remote_address();
                match conn.await {
                    Ok(connection) => {
                        info!("[P2P] Accepted incoming connection from {}", remote_addr);
                        
                        // 1. Handshake: Receive peer ID
                        let peer_id = match connection.accept_uni().await {
                            Ok(mut recv) => {
                                match recv.read_to_end(64).await {
                                    Ok(id_bytes) => String::from_utf8_lossy(&id_bytes).to_string(),
                                    Err(e) => {
                                        warn!("[P2P] Failed to read handshake ID from {}: {}", remote_addr, e);
                                        return;
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("[P2P] Failed to accept handshake stream from {}: {}", remote_addr, e);
                                return;
                            }
                        };

                        info!("P2P handshake successful from peer: {}", peer_id);
                        {
                            let mut conns = connections.lock().await;
                            conns.insert(peer_id.clone(), connection.clone());
                        }
                        let _ = event_tx.send(P2PEvent::Connected(peer_id.clone())).await;

                        // Monitor disconnection
                        let etx = event_tx.clone();
                        let pid = peer_id.clone();
                        let conns_clone = connections.clone();
                        let conn_clone = connection.clone();
                        tokio::spawn(async move {
                            let _ = conn_clone.closed().await;
                            info!("P2P connection from {} closed", pid);
                            let mut conns = conns_clone.lock().await;
                            conns.remove(&pid);
                            let _ = etx.send(P2PEvent::Disconnected(pid)).await;
                        });

                        // Handle Datagrams (Fast path for IP packets)
                        let tw_dg = tun_writer.clone();
                        let conn_dg = connection.clone();
                        tokio::spawn(async move {
                            loop {
                                match conn_dg.read_datagram().await {
                                    Ok(dg) => {
                                        let mut writer = tw_dg.lock().await;
                                        let _ = writer.write_all(&dg).await;
                                    }
                                    Err(_) => break,
                                }
                            }
                        });

                        // Handle Unidirectional Streams (Fallback/Large packets)
                        loop {
                            match connection.accept_uni().await {
                                Ok(mut recv) => {
                                    let tun_writer = tun_writer.clone();
                                    tokio::spawn(async move {
                                        if let Ok(buf) = recv.read_to_end(65535).await {
                                            let mut writer = tun_writer.lock().await;
                                            let _ = writer.write_all(&buf).await;
                                        }
                                    });
                                }
                                Err(_) => break,
                            }
                        }
                    }
                    Err(e) => {
                        warn!("[P2P] Failed to accept QUIC connection from {}: {}", remote_addr, e);
                    }
                }
            });
        }
    }
}




fn make_client_config() -> quinn::ClientConfig {
    let mut crypto = rustls::ClientConfig::builder()
        .with_safe_defaults()
        .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
        .with_no_client_auth();
    
    crypto.alpn_protocols = vec![b"syuink-p2p".to_vec()];
    let mut client_config = quinn::ClientConfig::new(Arc::new(crypto));
    
    let mut transport_config = quinn::TransportConfig::default();
    transport_config.keep_alive_interval(Some(std::time::Duration::from_secs(5)));
    client_config.transport_config(Arc::new(transport_config));
    
    client_config
}


fn make_server_endpoint(bind_addr: SocketAddr) -> Result<(Endpoint, Vec<u8>)> {
    let (cert_der, key_der) = generate_self_signed_cert()?;
    let cert = rustls::Certificate(cert_der.clone());
    let key = rustls::PrivateKey(key_der);
    
    let mut crypto = rustls::ServerConfig::builder()
        .with_safe_defaults()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)?;
    crypto.alpn_protocols = vec![b"syuink-p2p".to_vec()];
    
    let mut server_config = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    let mut transport_config = quinn::TransportConfig::default();


    transport_config.keep_alive_interval(Some(std::time::Duration::from_secs(5)));
    // Enable datagrams
    transport_config.datagram_receive_buffer_size(Some(1024 * 1024));
    transport_config.datagram_send_buffer_size(1024 * 1024);
    
    server_config.transport_config(Arc::new(transport_config));
    
    let endpoint = Endpoint::server(server_config, bind_addr)?;
    Ok((endpoint, cert_der))
}


fn generate_self_signed_cert() -> Result<(Vec<u8>, Vec<u8>)> {
    let cert = rcgen::generate_simple_self_signed(vec!["syuink-p2p".into()])?;
    Ok((cert.serialize_der()?, cert.serialize_private_key_der()))
}

struct SkipServerVerification;

impl rustls::client::ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::Certificate,
        _intermediates: &[rustls::Certificate],
        _server_name: &rustls::ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: std::time::SystemTime,
    ) -> Result<rustls::client::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::ServerCertVerified::assertion())
    }
}

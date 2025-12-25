use anyhow::Result;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info, warn};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ServiceDecl {
    pub ip: String,
    pub port: u16,
    pub protocol: String, // "tcp", "udp"
    pub service_type: String, // "generic", "printer", "discovery"
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum SignalMessage {
    #[serde(rename = "join")]
    Join {
        id: String,
        ip: String,
        name: String,
        #[serde(default)]
        p2p_port: u16,
        #[serde(default)]
        os: Option<String>,

        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        device_type: Option<String>,
        #[serde(default)]
        is_gateway: bool,
    },
    #[serde(rename = "register_services")]
    RegisterServices {
        id: String,
        services: Vec<ServiceDecl>,
    },
    #[serde(rename = "service_update")]
    ServiceUpdate {
        // List of all services in the network: (PeerID, ServiceDecl)
        services: Vec<(String, ServiceDecl)>,
    },
    #[serde(rename = "peer_joined")]
    PeerJoined {
        id: String,
        ip: String,
        #[serde(default)]
        public_addr: Option<String>,
        #[serde(default)]
        p2p_port: u16,
        name: String,
        #[serde(default)]
        os: Option<String>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        device_type: Option<String>,
        #[serde(default)]
        is_gateway: bool,
        #[serde(default)]
        connected_at: Option<u64>,
    },
    #[serde(rename = "peer_left")]
    PeerLeft {
        id: String,
    },
    // Direct P2P negotiation
    #[serde(rename = "offer")]
    Offer {
        target: String,
        source: String,
        sdp: String,
    },
    #[serde(rename = "answer")]
    Answer {
        target: String,
        source: String,
        sdp: String,
    },
    #[serde(rename = "candidate")]
    Candidate {
        target: String,
        source: String,
        candidate: String,
    },
    #[serde(rename = "broadcast")]
    Broadcast {
        source: String,
        data: String, // Base64 encoded packet
    },
    #[serde(rename = "tun_packet")]
    TunPacket {
        target: String,
        source: String,
        data: String,
    },
    #[serde(rename = "tcp_connect")]
    TcpConnect {
        stream_id: u32,
        target: String,
        source: String,
        target_ip: String,
        target_port: u16,
    },
    #[serde(rename = "tcp_connected")]
    TcpConnected {
        stream_id: u32,
        target: String,
        source: String,
        success: bool,
    },
    #[serde(rename = "tcp_data")]
    TcpData {
        stream_id: u32,
        target: String,
        source: String,
        data: String,
    },
    #[serde(rename = "tcp_close")]
    TcpClose {
        stream_id: u32,
        target: String,
        source: String,
    },
}

#[derive(Clone)]
pub struct SignalingClient {
    tx: mpsc::Sender<SignalMessage>,
}

impl SignalingClient {
    pub async fn connect(
        server_url: &str,
        group_id: &str,
        token: Option<String>,
        my_id: String,
        my_ip: String,
        my_name: String,
        p2p_port: u16,
        my_meta: (Option<String>, Option<String>, Option<String>, bool), // os, ver, type, gateway
        incoming_tx: mpsc::Sender<SignalMessage>,
    ) -> Result<Self> {
        // Construct base URL: {server_url}/wapi/{group_id}
        // Ensure server_url doesn't end with slash to avoid double slash (though parser handles it)
        let base_str = format!("{}/wapi/{}", server_url.trim_end_matches('/'), group_id);
        let mut url = Url::parse(&base_str)?;

        // If token provided, add to query params
        if let Some(t) = token {
            url.query_pairs_mut().append_pair("token", &t);
        }

        info!("Connecting to signaling server: {}", url);

        let (ws_stream, _) = connect_async(url).await?;
        info!("WebSocket connected");

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<SignalMessage>(32);

        // Send JOIN immediately
        let join_msg = SignalMessage::Join {
            id: my_id.clone(),
            ip: my_ip,
            name: my_name,
            p2p_port,
            os: my_meta.0,
            version: my_meta.1,
            device_type: my_meta.2,
            is_gateway: my_meta.3,
        };
        let json = serde_json::to_string(&join_msg)?;
        write.send(Message::Text(json)).await?;

        // Background task to handle WS I/O
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Outbound messages (Local -> Server)
                    msg = rx.recv() => {
                        match msg {
                            Some(msg) => {
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    if let Err(e) = write.send(Message::Text(json)).await {
                                        error!("Failed to send WS message: {}", e);
                                        break;
                                    }
                                }
                            }
                            None => {
                                info!("Signaling client dropped, closing WebSocket");
                                let _ = write.close().await;
                                break;
                            }
                        }
                    }
                    
                    // Inbound messages (Server -> Local)
                    Some(msg) = read.next() => {
                        match msg {
                            Ok(Message::Text(text)) => {
                                if let Ok(signal) = serde_json::from_str::<SignalMessage>(&text) {
                                    if let Err(_) = incoming_tx.send(signal).await {
                                        break; // Receiver dropped
                                    }
                                } else {
                                    warn!("Received unknown message format: {}", text);
                                }
                            }
                            Ok(Message::Close(_)) => {
                                info!("Signaling connection closed by server");
                                break;
                            }
                            Err(e) => {
                                error!("WS read error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                    
                    else => {
                        info!("Signaling loop select else branch hit (likely read stream finished)");
                        break;
                    }
                }
            }
            info!("Signaling loop exited. Dropping WebSocket.");
        });

        Ok(Self { tx })
    }

    pub async fn send(&self, msg: SignalMessage) -> Result<()> {
        self.tx.send(msg).await?;
        Ok(())
    }
}

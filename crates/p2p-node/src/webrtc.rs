use crate::signaling::{SignalMessage, SignalingClient};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use std::time::Duration;
use crate::p2p::{P2PEvent, P2PTransport};
use tokio::io::AsyncWriteExt;
use tun_device::AsyncDevice;

pub struct WebRTCManager {
    api: webrtc::api::API,
    connections: Arc<Mutex<HashMap<String, Arc<RTCPeerConnection>>>>,
    my_id: String,
    tun_writer: Arc<Mutex<tokio::io::WriteHalf<AsyncDevice>>>,
    event_tx: tokio::sync::mpsc::Sender<P2PEvent>,
    ice_servers: Vec<RTCIceServer>,
}

impl WebRTCManager {
    pub async fn new(
        my_id: String,
        tun_writer: Arc<Mutex<tokio::io::WriteHalf<AsyncDevice>>>,
        event_tx: tokio::sync::mpsc::Sender<P2PEvent>,
    ) -> Result<Self> {

        let ice_servers = Self::fetch_stun_servers().await;

        let mut m = MediaEngine::default();
        m.register_default_codecs()?;

        let mut registry = webrtc::interceptor::registry::Registry::new();
        registry = register_default_interceptors(registry, &mut m)?;

        let mut s = webrtc::api::setting_engine::SettingEngine::default();
        s.set_network_types(vec![
            webrtc::ice::network_type::NetworkType::Udp4,
            webrtc::ice::network_type::NetworkType::Udp6,
        ]);
        // Disable mDNS to avoid long timeouts and warnings if not needed
        s.set_ice_multicast_dns_mode(webrtc::ice::mdns::MulticastDnsMode::Disabled);


        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .with_setting_engine(s)
            .build();

        Ok(Self {
            api,
            connections: Arc::new(Mutex::new(HashMap::new())),
            my_id,
            tun_writer,
            event_tx,
            ice_servers,
        })
    }

    async fn fetch_stun_servers() -> Vec<RTCIceServer> {
        const STUN_URL: &str = "https://hk.gh-proxy.org/https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt";
        let default_server = RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        };

        info!("[STUN] Fetching server list from {}", STUN_URL);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(800))
            .build();

        let client = match client {
            Ok(c) => c,
            Err(e) => {
                warn!("[STUN] Failed to build HTTP client: {}. Falling back to default.", e);
                return vec![default_server];
            }
        };

        match client.get(STUN_URL).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    match response.text().await {
                        Ok(text) => {
                            let mut servers: Vec<RTCIceServer> = text
                                .lines()
                                .filter(|line| !line.trim().is_empty())
                                .map(|line| RTCIceServer {
                                    urls: vec![format!("stun:{}", line.trim())],
                                    ..Default::default()
                                })
                                .collect();

                            if servers.is_empty() {
                                warn!("[STUN] Fetched list is empty. Using default server.");
                                vec![default_server]
                            } else {
                                info!("[STUN] Fetched and parsed {} servers.", servers.len());
                                // Also add the default as a final fallback
                                servers.push(default_server);
                                servers
                            }
                        },
                        Err(e) => {
                            warn!("[STUN] Failed to parse response text: {}. Falling back to default.", e);
                            vec![default_server]
                        }
                    }
                } else {
                    warn!(
                        "[STUN] Fetch failed with status: {}. Falling back to default.",
                        response.status()
                    );
                    vec![default_server]
                }
            }
            Err(e) => {
                warn!("[STUN] Fetch failed: {}. Falling back to default.", e);
                vec![default_server]
            }
        }
    }

    pub async fn connect_to(
        &self,
        peer_id: String,
        signal_client: Arc<SignalingClient>,
    ) -> Result<()> {
        info!("[WebRTC] Initiating connection to peer {}", peer_id);

        let peer_connection = self.create_peer_connection(peer_id.clone(), signal_client.clone()).await?;

        let data_channel = peer_connection.create_data_channel("data", None).await?;
        let d = data_channel.clone();
        let event_tx = self.event_tx.clone();
        let peer_id_clone = peer_id.clone();
        let tun_writer = self.tun_writer.clone();

        data_channel.on_open(Box::new(move || {
            info!("[WebRTC] Data channel '{}'-'{}' open", d.label(), d.id());
            let event_tx = event_tx.clone();
            let peer_id = peer_id_clone.clone();
            Box::pin(async move {
                let _ = event_tx.send(P2PEvent::Connected(peer_id, P2PTransport::WebRTC)).await;
            })
        }));

        data_channel.on_message(Box::new(move |msg| {
            debug!("[WebRTC] Message from DataChannel: '{}' bytes", msg.data.len());
            let tun_writer = tun_writer.clone();
            let data = msg.data.to_vec();
            Box::pin(async move {
                 let mut writer = tun_writer.lock().await;
                 if let Err(e) = writer.write_all(&data).await {
                     warn!("[WebRTC] Failed to write to TUN device: {}", e);
                 }
            })
        }));

        let offer = peer_connection.create_offer(None).await?;
        let sdp = offer.sdp.clone();
        peer_connection.set_local_description(offer).await?;

        info!("[WebRTC] Sending offer to peer {}", peer_id);
        signal_client.send(SignalMessage::Offer {
            source: self.my_id.clone(),
            target: peer_id,
            sdp,
        }).await?;

        Ok(())
    }

    pub async fn handle_offer(&self, source: String, sdp: String, signal_client: Arc<SignalingClient>) -> Result<()> {
        info!("[WebRTC] Received offer from {}", source);

        let peer_connection = self.create_peer_connection(source.clone(), signal_client.clone()).await?;

        let offer = RTCSessionDescription::offer(sdp)?;
        peer_connection.set_remote_description(offer).await?;

        let answer = peer_connection.create_answer(None).await?;
        let sdp = answer.sdp.clone();
        peer_connection.set_local_description(answer).await?;

        info!("[WebRTC] Sending answer to peer {}", source);
        signal_client.send(SignalMessage::Answer {
            source: self.my_id.clone(),
            target: source,
            sdp,
        }).await?;

        Ok(())
    }

    pub async fn handle_answer(&self, source: String, sdp: String) -> Result<()> {
        info!("[WebRTC] Received answer from {}", source);
        let connections = self.connections.lock().await;
        if let Some(pc) = connections.get(&source) {
            let answer = RTCSessionDescription::answer(sdp)?;
            pc.set_remote_description(answer).await?;
        } else {
            warn!("[WebRTC] Received answer from unknown peer {}", source);
        }
        Ok(())
    }

    pub async fn handle_candidate(&self, source: String, candidate: String) -> Result<()> {
        info!("[WebRTC] Received ICE candidate from {}", source);
        let connections = self.connections.lock().await;
        if let Some(pc) = connections.get(&source) {
            let candidate_init: RTCIceCandidateInit = serde_json::from_str(&candidate)?;
            pc.add_ice_candidate(candidate_init).await?;
        } else {
            warn!("[WebRTC] Received candidate from unknown peer {}", source);
        }
        Ok(())
    }

    async fn create_peer_connection(&self, peer_id: String, signal_client: Arc<SignalingClient>) -> Result<Arc<RTCPeerConnection>> {
        let config = RTCConfiguration {
            ice_servers: self.ice_servers.clone(),
            ..Default::default()
        };

        let peer_connection = Arc::new(self.api.new_peer_connection(config).await?);
        self.connections.lock().await.insert(peer_id.clone(), peer_connection.clone());

        let my_id = self.my_id.clone();
        let target_peer_id = peer_id.clone();

        peer_connection.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
            let signal_client = signal_client.clone();
            let my_id = my_id.clone();
            let target_peer_id = target_peer_id.clone();
            
            Box::pin(async move {
                if let Some(candidate) = candidate {
                    match candidate.to_json() {
                        Ok(json_str) => {
                            info!("[WebRTC] Sending ICE candidate to {}", target_peer_id);
                            let _ = signal_client.send(SignalMessage::Candidate {
                                source: my_id,
                                target: target_peer_id,
                                candidate: json_str.candidate,
                            }).await;
                        },
                        Err(e) => {
                            warn!("[WebRTC] Failed to serialize ICE candidate: {}", e);
                        }
                    }
                }
            })
        }));

        let pc_clone = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            info!("[WebRTC] Peer Connection State has changed: {}", s);
            if s == RTCPeerConnectionState::Failed {
                info!("[WebRTC] Peer Connection has failed. Closing connection");
                let pc = pc_clone.clone();
                tokio::spawn(async move {
                    let _ = pc.close().await;
                });
            }
            Box::pin(async {})
        }));
        
        let event_tx_clone = self.event_tx.clone();
        let peer_id_clone = peer_id.clone();
        let tun_writer_clone = self.tun_writer.clone();

        peer_connection.on_data_channel(Box::new(move |d| {
            info!("[WebRTC] New DataChannel {} {}", d.label(), d.id());
            let d_clone = d.clone();
            let event_tx = event_tx_clone.clone();
            let peer_id = peer_id_clone.clone();
            let tun_writer = tun_writer_clone.clone();

            d.on_open(Box::new(move || {
                info!("[WebRTC] Data channel '{}'-'{}' open", d_clone.label(), d_clone.id());
                let event_tx = event_tx.clone();
                let peer_id = peer_id.clone();
                Box::pin(async move {
                    let _ = event_tx.send(P2PEvent::Connected(peer_id, P2PTransport::WebRTC)).await;
                })
            }));

            d.on_message(Box::new(move |msg| {
                debug!("[WebRTC] Message from DataChannel: '{}' bytes", msg.data.len());
                let tun_writer = tun_writer.clone();
                let data = msg.data.to_vec();
                Box::pin(async move {
                    let mut writer = tun_writer.lock().await;
                    if let Err(e) = writer.write_all(&data).await {
                        warn!("[WebRTC] Failed to write to TUN device: {}", e);
                    }
                })
            }));

            Box::pin(async {})
        }));

        Ok(peer_connection)
    }
    

}

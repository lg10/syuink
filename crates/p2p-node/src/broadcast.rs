use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use anyhow::Result;
use tracing::{info, debug};

const MDNS_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const SSDP_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;

pub struct BroadcastReflector {
    mdns_socket: UdpSocket,
    ssdp_socket: UdpSocket,
}

impl BroadcastReflector {
    pub async fn new() -> Result<Self> {
        let mdns_socket = create_multicast_socket(MDNS_ADDR, MDNS_PORT)?;
        let ssdp_socket = create_multicast_socket(SSDP_ADDR, SSDP_PORT)?;

        info!("Broadcast Reflector started on mDNS (5353) and SSDP (1900)");

        Ok(Self {
            mdns_socket,
            ssdp_socket,
        })
    }

    /// Receive loop: Listens for local multicast packets and sends them to the channel
    pub async fn listen_loop(&self, tx: tokio::sync::mpsc::Sender<(Vec<u8>, u16)>) {
        let mut mdns_buf = [0u8; 4096];
        let mut ssdp_buf = [0u8; 4096];

        loop {
            tokio::select! {
                res = self.mdns_socket.recv_from(&mut mdns_buf) => {
                    if let Ok((len, addr)) = res {
                        // Avoid forwarding our own packets (simple loopback check)
                        // In production, we need smarter filtering.
                        debug!("Received mDNS packet from {}", addr);
                        let packet = mdns_buf[..len].to_vec();
                        let _ = tx.send((packet, MDNS_PORT)).await;
                    }
                }
                res = self.ssdp_socket.recv_from(&mut ssdp_buf) => {
                    if let Ok((len, addr)) = res {
                         debug!("Received SSDP packet from {}", addr);
                        let packet = ssdp_buf[..len].to_vec();
                        let _ = tx.send((packet, SSDP_PORT)).await;
                    }
                }
            }
        }
    }

    /// Replay loop: Receives packets from VPN and broadcasts them locally
    pub async fn replay(&self, data: &[u8], port: u16) -> Result<()> {
        let target_addr = match port {
            5353 => SocketAddrV4::new(MDNS_ADDR, MDNS_PORT),
            1900 => SocketAddrV4::new(SSDP_ADDR, SSDP_PORT),
            _ => return Ok(()), // Ignore unknown protocols
        };

        let socket = match port {
            5353 => &self.mdns_socket,
            1900 => &self.ssdp_socket,
            _ => return Ok(()),
        };

        socket.send_to(data, target_addr).await?;
        Ok(())
    }
}

fn create_multicast_socket(multicast_addr: Ipv4Addr, port: u16) -> Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    
    // Allow reusing the port so we can coexist with system services (Avahi/Bonjour)
    #[cfg(not(target_os = "windows"))]
    socket.set_reuse_address(true)?;
    #[cfg(target_os = "windows")]
    socket.set_reuse_address(true)?; // Windows treats reuse_address like SO_REUSEADDR in *nix

    // Bind to ANY address
    socket.bind(&SocketAddr::from(([0, 0, 0, 0], port)).into())?;

    // Join the multicast group
    socket.join_multicast_v4(&multicast_addr, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_multicast_loop_v4(true)?; // We want to hear ourselves? Usually no, but for testing maybe.

    socket.set_nonblocking(true)?;

    Ok(UdpSocket::from_std(socket.into())?)
}

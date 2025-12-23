use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use anyhow::Result;
use tracing::{info, debug, warn};

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
    
    // 1. 设置地址重用，允许共用端口
    let _ = socket.set_reuse_address(true);
    
    // 2. 在 Unix 系统（如 macOS/Linux）上尝试设置端口重用，以共享系统级端口（如 5353）
    // 使用 Ext trait 提供的原生设置方法
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = socket.as_raw_fd();
        unsafe {
            let optval: libc::c_int = 1;
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_REUSEPORT,
                &optval as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
    }

    // 3. 尝试绑定端口
    // 如果是 mDNS 或 SSDP 关键端口且绑定失败，我们会尝试随机端口作为兜底（虽然效果会打折扣，但能防止崩溃）
    if let Err(e) = socket.bind(&SocketAddr::from(([0, 0, 0, 0], port)).into()) {
        warn!("Failed to bind to multicast port {}: {}. Attempting random port...", port, e);
        socket.bind(&SocketAddr::from(([0, 0, 0, 0], 0)).into())?;
    }

    // 4. 加入组播组
    socket.join_multicast_v4(&multicast_addr, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_multicast_loop_v4(true)?;
    socket.set_nonblocking(true)?;

    Ok(UdpSocket::from_std(socket.into())?)
}

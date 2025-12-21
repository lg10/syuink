use clap::Parser;
use p2p_node::P2PNode;
use std::net::Ipv4Addr;
use tracing::info;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short, long, default_value = "10.10.0.2")]
    ip: String,
    
    #[arg(short, long, default_value = "255.255.255.0")]
    mask: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    tracing_subscriber::fmt::init();
    
    let args = Args::parse();
    let ip: Ipv4Addr = args.ip.parse()?;
    let mask: Ipv4Addr = args.mask.parse()?;

    info!("Starting Syuink VPN Node...");
    info!("Virtual IP: {}", ip);
    info!("Netmask: {}", mask);
    
    let node = P2PNode::new(ip, mask);
    
    // Check if we have admin privileges (required for TUN)
    #[cfg(target_os = "windows")]
    info!("Note: Make sure to run this as Administrator for Wintun to work.");

    node.start().await?;

    Ok(())
}

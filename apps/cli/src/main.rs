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
    
    let node = P2PNode::new(ip, mask, "CLI Node".to_string());
    
    // Check if we have admin privileges (required for TUN)
    #[cfg(target_os = "windows")]
    info!("Note: Make sure to run this as Administrator for Wintun to work.");

    let (shutdown_tx, _shutdown_rx) = tokio::sync::broadcast::channel(1);
    let (_cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(32);
    
    let signaling_url = std::env::var("SIGNALING_URL").unwrap_or_else(|_| "ws://127.0.0.1:8787".to_string());
    let node_id = uuid::Uuid::new_v4().to_string();

    node.start(
        shutdown_tx.subscribe(),
        None,
        None,
        signaling_url,
        None,
        node_id,
        (Some("CLI".to_string()), None, Some("cli".to_string()), false),
        vec![],
        cmd_rx
    ).await?;


    Ok(())
}

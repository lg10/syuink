#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use p2p_node::{P2PNode, PeerInfo, NodeCommand};
use p2p_node::signaling::ServiceDecl;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;
use tokio::sync::broadcast;

struct VpnState {
    shutdown_tx: Mutex<Option<broadcast::Sender<()>>>,
    current_ip: Mutex<Option<String>>,
    socks5_port: Mutex<Option<u16>>,
    command_tx: Mutex<Option<tokio::sync::mpsc::Sender<NodeCommand>>>,
}

use tauri::Emitter;

#[tauri::command]
async fn start_vpn(
    app: tauri::AppHandle,
    state: State<'_, VpnState>, 
    device_name: Option<String>,
    node_id: Option<String>,
    token: Option<String>,
    server_url: Option<String>,
    is_gateway: bool,
    services: Vec<ServiceDecl>
) -> Result<String, String> {
    // Check if already running
    {
        let current_ip = state.current_ip.lock().unwrap();
        let current_port = state.socks5_port.lock().unwrap();
        if let Some(ref ip) = *current_ip {
            let port = current_port.unwrap_or(0);
            return Ok(format!("{}|{}", ip, port));
        }
    }

    // Collect System Info
    let os = sysinfo::System::name();
    let version = sysinfo::System::os_version();
    let device_type = Some("desktop".to_string());
    let my_meta = (os, version, device_type, is_gateway);

    let name = device_name.unwrap_or_else(|| "My Device".to_string());
    // Generate UUID if not provided (should be provided by frontend for persistence)
    let my_id = node_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    
    println!("Request to start VPN for device: {} (ID: {})", name, my_id);
    
    // Always start from .2 and let auto-discovery find the next free IP
    let start_ip_str = "10.10.0.2"; 
    
    let ip_addr: Ipv4Addr = start_ip_str.parse().map_err(|e| format!("IP格式错误: {}", e))?;
    let mask: Ipv4Addr = "255.255.255.0".parse().unwrap();
    
    // Create shutdown channel
    let (tx, rx) = broadcast::channel(1);
    
    // Store tx in state
    {
        let mut shutdown_tx = state.shutdown_tx.lock().unwrap();
        *shutdown_tx = Some(tx.clone());
    }

    // Create Command Channel
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(32);
    {
        let mut command_tx = state.command_tx.lock().unwrap();
        *command_tx = Some(cmd_tx);
    }

    // Create a channel to receive the allocated IP and SOCKS5 port from the node
    let (ip_report_tx, mut ip_report_rx) = tokio::sync::mpsc::channel(1);

    // Create a channel to receive peer updates
    let (peer_update_tx, mut peer_update_rx) = tokio::sync::mpsc::channel(32);

    // Spawn the peer update listener task
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(peers) = peer_update_rx.recv().await {
            let _ = app_handle.emit("peers-updated", &peers);
        }
    });
    
    // Spawn the VPN node
    // We use a channel to communicate the allocated IP back to the main thread
    let (result_tx, mut result_rx) = tokio::sync::mpsc::channel(1);
    
    tauri::async_runtime::spawn(async move {
        println!("Initializing P2P Node...");
        
        #[cfg(target_os = "windows")]
        {
            // ... (cleanup code) ...
             use std::process::Command;
             println!("Cleaning up old Syuink adapters...");
             let _ = Command::new("powershell")
                 .args(&[
                     "-Command",
                     "Get-PnpDevice | Where-Object { $_.FriendlyName -like 'Syuink*' } | ForEach-Object { Write-Host 'Removing ' $_.FriendlyName; pnputil /remove-device $_.InstanceId /force }",
                 ])
                 .output();
        }

        let node = P2PNode::new(ip_addr, mask, name);
        
        // Pass the shutdown receiver AND the IP report sender
        // Construct Signaling URL with Token
        let base_url = server_url.unwrap_or_else(|| "ws://127.0.0.1:8787".to_string());
        
        // Pass token separately to node.start, do NOT append it to base_url query
        match node.start(rx, Some(ip_report_tx), Some(peer_update_tx), base_url, token, my_id, my_meta, services, cmd_rx).await {
            Ok((allocated_ip, _port)) => {
                println!("VPN Node finished/stopped. Last IP: {}", allocated_ip);
                let _ = result_tx.send(Ok(allocated_ip)).await;
            },
            Err(e) => {
                eprintln!("VPN Node CRITICAL ERROR: {:?}", e);
                let _ = result_tx.send(Err(e.to_string())).await;
            },
        }
    });
    
    // Wait for IP allocation (with timeout)
    // This makes start_vpn wait until the network is actually ready
    use tokio::time::{timeout, Duration};
    let wait_result = timeout(Duration::from_secs(15), ip_report_rx.recv()).await;
    
    let (allocated_ip, socks5_port) = match wait_result {
        Ok(Some(info)) => info,
        Ok(None) => return Err("Failed to allocate IP (Channel closed)".to_string()),
        Err(_) => return Err("Timeout waiting for IP allocation".to_string()),
    };

    println!("VPN successfully started with IP: {}, SOCKS5 Port: {}", allocated_ip, socks5_port);

    // Update state 
    {
        let mut current = state.current_ip.lock().unwrap();
        *current = Some(allocated_ip.clone());
        let mut port = state.socks5_port.lock().unwrap();
        *port = Some(socks5_port);
    }

    // Return the IP and Port to frontend
    // We return JSON string for simplicity to avoid changing Tauri return type signature too much
    // Or just format it as "IP|Port"
    Ok(format!("{}|{}", allocated_ip, socks5_port))
}

#[tauri::command]
async fn set_system_proxy(enable: bool, port: u16) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        if enable {
             println!("Enabling System Proxy on 127.0.0.1:{}", port);
             // 1. Enable Proxy
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
             // 2. Set Proxy Server
             let proxy_server = format!("socks=127.0.0.1:{}", port);
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer", "/t", "REG_SZ", "/d", &proxy_server, "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
             // 3. Set Proxy Override (Bypass local)
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "<local>", "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
        } else {
             println!("Disabling System Proxy");
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
        }
        
        // Notify system (This is a bit hacky via PowerShell, ideally call InternetSetOption)
        // This PS command forces a refresh of settings
        let _ = Command::new("powershell")
            .args(&["-Command", "$mk = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $v = (Get-ItemProperty -Path $mk).ProxyEnable; Set-ItemProperty -Path $mk -Name ProxyEnable -Value $v"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
            
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // Get active network service (Wi-Fi or Ethernet)
        // Simplified: Try "Wi-Fi" then "Ethernet"
        let services = ["Wi-Fi", "Ethernet", "Thunderbolt Bridge"];
        
        for service in services {
            if enable {
                 let _ = Command::new("networksetup")
                     .args(&["-setsocksfirewallproxy", service, "127.0.0.1", &port.to_string()])
                     .output();
                 let _ = Command::new("networksetup")
                     .args(&["-setsocksfirewallproxystate", service, "on"])
                     .output();
            } else {
                 let _ = Command::new("networksetup")
                     .args(&["-setsocksfirewallproxystate", service, "off"])
                     .output();
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // Linux is complex (GNOME vs KDE). Just log for now.
        println!("System proxy setting not fully supported on Linux yet.");
        Ok(())
    }
}

#[tauri::command]
async fn update_services(
    state: State<'_, VpnState>,
    services: Vec<ServiceDecl>
) -> Result<(), String> {
    let sender = {
        let tx = state.command_tx.lock().unwrap();
        tx.clone()
    };

    if let Some(sender) = sender {
        sender.send(NodeCommand::UpdateServices(services))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        // Not running, ignore
        Ok(())
    }
}

#[tauri::command]
async fn stop_vpn(state: State<'_, VpnState>) -> Result<String, String> {
    let tx = {
        let mut shutdown_tx = state.shutdown_tx.lock().unwrap();
        shutdown_tx.take()
    };

    if let Some(tx) = tx {
        let _ = tx.send(());
        
        {
            let mut current = state.current_ip.lock().unwrap();
            *current = None;
            let mut port = state.socks5_port.lock().unwrap();
            *port = None;
        }
        
        // Also clear command tx
        {
            let mut cmd = state.command_tx.lock().unwrap();
            *cmd = None;
        }

        // Disable System Proxy
        let _ = set_system_proxy(false, 0).await;
        
        Ok("VPN 服务已停止".to_string())
    } else {
        Err("VPN 未运行".to_string())
    }
}

#[tauri::command]
fn get_hostname() -> String {
    #[cfg(target_os = "windows")]
    return std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Unknown Device".to_string());

    #[cfg(not(target_os = "windows"))]
    return std::env::var("HOSTNAME").unwrap_or_else(|_| "Unknown Device".to_string());
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main").expect("no main window").set_focus();
        }))
        .manage(VpnState {
            shutdown_tx: Mutex::new(None),
            current_ip: Mutex::new(None),
            socks5_port: Mutex::new(None),
            command_tx: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![start_vpn, stop_vpn, get_hostname, update_services, set_system_proxy])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

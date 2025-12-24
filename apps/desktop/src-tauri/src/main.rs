#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use p2p_node::{P2PNode, PeerInfo, NodeCommand};
use p2p_node::signaling::ServiceDecl;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Wry,
};
use tauri::Manager;
use tauri::State;
use tokio::sync::broadcast;

struct VpnState {
    shutdown_tx: Mutex<Option<broadcast::Sender<()>>>,
    current_ip: Mutex<Option<String>>,
    socks5_port: Mutex<Option<u16>>,
    command_tx: Mutex<Option<tokio::sync::mpsc::Sender<NodeCommand>>>,
    menu_connected: Mutex<Option<CheckMenuItem<Wry>>>,
    menu_rules: Mutex<Option<CheckMenuItem<Wry>>>,
    menu_global: Mutex<Option<CheckMenuItem<Wry>>>,
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
    ip: Option<String>,
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
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    
    let os = if cfg!(target_os = "macos") {
        Some("macOS".to_string())
    } else if cfg!(target_os = "windows") {
        Some("Windows".to_string())
    } else {
        System::name()
    };
    let version = System::os_version();
    let device_type = Some("desktop".to_string());
    let my_meta = (os, version, device_type, is_gateway);

    let name = device_name.unwrap_or_else(|| "My Device".to_string());
    // Generate UUID if not provided (should be provided by frontend for persistence)
    let my_id = node_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    
    println!("Request to start VPN for device: {} (ID: {})", name, my_id);
    
    // Use provided IP or default to .2
    let start_ip_str = ip.unwrap_or_else(|| "10.10.0.2".to_string()); 
    
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
    
    // Create a channel to wait for the node's background task result
    let (node_result_tx, mut node_result_rx) = tokio::sync::mpsc::channel(1);
    
    // Spawn the VPN node
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
        
        println!("Starting P2P Node with Signaling URL: {}", base_url);

        // Pass token separately to node.start, do NOT append it to base_url query
        let result = node.start(rx, Some(ip_report_tx), Some(peer_update_tx), base_url, token, my_id, my_meta, services, cmd_rx).await;
        
        match result {
            Ok((allocated_ip, _port)) => {
                println!("VPN Node finished/stopped successfully. Last IP: {}", allocated_ip);
                let _ = node_result_tx.send(Ok(allocated_ip)).await;
            },
            Err(e) => {
                // IMPORTANT: Log to stderr so user sees it in terminal
                eprintln!("VPN Node CRITICAL ERROR: {:?}", e);
                
                // Get a user-friendly error string
                let error_msg = if format!("{:?}", e).contains("Operation not permitted") {
                    "权限不足: 即使使用了 sudo，系统仍拒绝创建虚拟网卡。请检查是否有其他 VPN 正在运行。".to_string()
                } else {
                    format!("VPN 启动失败: {:?}", e)
                };
                
                let _ = node_result_tx.send(Err(error_msg)).await;
            },
        }
    });
    
    // Wait for IP allocation or node crash
    use tokio::time::Duration;
    
    tokio::select! {
        ip_info = ip_report_rx.recv() => {
            match ip_info {
                Some((allocated_ip, socks5_port)) => {
                    println!("VPN successfully started with IP: {}, SOCKS5 Port: {}", allocated_ip, socks5_port);
                    // Update state 
                    {
                        let mut current = state.current_ip.lock().unwrap();
                        *current = Some(allocated_ip.clone());
                        let mut port = state.socks5_port.lock().unwrap();
                        *port = Some(socks5_port);
                    }
                    let result = format!("{}|{}", allocated_ip, socks5_port);
                    let _ = app.emit("vpn-connected", &result);
                    
                    // Update Tray Icon
                    let _ = app.tray_by_id("main").map(|tray| {
                        let _ = tray.set_icon(Some(tauri::image::Image::from_bytes(include_bytes!("../icons/icon_connected.png")).unwrap()));
                        let _ = tray.set_tooltip(Some("Syuink VPN: 已连接"));
                    });
                    
                    {
                        let connected_lock = state.menu_connected.lock().unwrap();
                        if let Some(item) = connected_lock.as_ref() {
                            let _ = item.set_checked(true);
                        }
                    }
                    Ok(result)
                }
                None => Err("IP 分配失败: 核心节点已意外关闭".to_string())
            }
        }
        node_err = node_result_rx.recv() => {
            match node_err {
                Some(Err(e)) => Err(e),
                _ => Err("VPN 启动失败: 核心进程退出".to_string())
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(15)) => {
            Err("连接超时: 等待 IP 分配超过 15 秒".to_string())
        }
    }
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
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
             let proxy_server = format!("socks=127.0.0.1:{}", port);
             let _ = Command::new("reg")
                 .args(&["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer", "/t", "REG_SZ", "/d", &proxy_server, "/f"])
                 .creation_flags(CREATE_NO_WINDOW)
                 .output();
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
        
        // Refresh
        let _ = Command::new("powershell")
            .args(&["-Command", "$mk = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $v = (Get-ItemProperty -Path $mk).ProxyEnable; Set-ItemProperty -Path $mk -Name ProxyEnable -Value $v"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        
        // Verify
        let verify = Command::new("reg")
            .args(&["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(out) = verify {
            let ok = if enable {
                String::from_utf8_lossy(&out.stdout).contains("0x1")
            } else {
                !String::from_utf8_lossy(&out.stdout).contains("0x1")
            };
            if ok {
                return Ok(());
            }
        }
        Err("系统代理设置校验失败".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let services = ["Wi-Fi", "Ethernet", "Thunderbolt Bridge"];
        let mut applied = false;
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
            // verify per service
            let verify = Command::new("networksetup")
                .args(&["-getsocksfirewallproxy", service])
                .output();
            if let Ok(out) = verify {
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                let enabled = text.contains("Enabled: Yes");
                let server_ok = text.contains("Server: 127.0.0.1");
                let port_ok = text.contains(&format!("Port: {}", port));
                if enable {
                    if enabled && server_ok && port_ok {
                        applied = true;
                        break;
                    }
                } else {
                    if !enabled {
                        applied = true;
                        break;
                    }
                }
            }
        }
        if applied { Ok(()) } else { Err("系统代理设置校验失败".to_string()) }
    }

    #[cfg(target_os = "linux")]
    {
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
async fn stop_vpn(app: tauri::AppHandle, state: State<'_, VpnState>) -> Result<String, String> {
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
        
        let _ = app.emit("vpn-disconnected", ());
        
        // Update Tray Icon (Disconnected)
        let _ = app.tray_by_id("main").map(|tray| {
            let _ = tray.set_icon(Some(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap()));
            let _ = tray.set_tooltip(Some("Syuink VPN: 未连接"));
        });
        
        {
            let connected_lock = state.menu_connected.lock().unwrap();
            if let Some(item) = connected_lock.as_ref() {
                let _ = item.set_checked(false);
            }
        }

        Ok("VPN 服务已停止".to_string())
    } else {
        Err("VPN 未运行".to_string())
    }
}

#[tauri::command]
fn get_vpn_status(state: State<'_, VpnState>) -> Result<String, String> {
    let current_ip = state.current_ip.lock().unwrap();
    let current_port = state.socks5_port.lock().unwrap();
    
    if let Some(ref ip) = *current_ip {
        let port = current_port.unwrap_or(0);
        return Ok(format!("{}|{}", ip, port));
    }
    
    Ok("".to_string())
}

#[derive(serde::Serialize)]
struct SystemInfo {
    os: String,
    version: String,
    hostname: String,
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    
    let os = if cfg!(target_os = "macos") {
        "macOS".to_string()
    } else if cfg!(target_os = "windows") {
        "Windows".to_string()
    } else {
        System::name().unwrap_or_else(|| "Unknown".to_string())
    };
    
    SystemInfo {
        os,
        version: System::os_version().unwrap_or_default(),
        hostname: get_hostname(),
    }
}

#[tauri::command]
fn get_hostname() -> String {
    #[cfg(target_os = "windows")]
    return std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Unknown Device".to_string());

    #[cfg(target_os = "macos")]
    {
        // On macOS, scutil --get ComputerName is the most user-friendly name
        use std::process::Command;
        let output = Command::new("scutil")
            .args(&["--get", "ComputerName"])
            .output();
        
        if let Ok(out) = output {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
        // Fallback to HOSTNAME env
        std::env::var("HOSTNAME").unwrap_or_else(|_| "Mac Device".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return std::env::var("HOSTNAME").unwrap_or_else(|_| "Unknown Device".to_string());
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn set_proxy_mode_menu(state: State<'_, VpnState>, mode: String) -> Result<(), String> {
    {
        let rules_lock = state.menu_rules.lock().unwrap();
        if let Some(item) = rules_lock.as_ref() {
            let _ = item.set_checked(mode != "global");
        }
    }
    {
        let global_lock = state.menu_global.lock().unwrap();
        if let Some(item) = global_lock.as_ref() {
            let _ = item.set_checked(mode == "global");
        }
    }
    Ok(())
}

fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        use std::env;

        // Check if we are running as root
        let uid = unsafe { libc::getuid() };
        if uid != 0 {
            println!("Not running as root, attempting to relaunch with sudo...");
            let args: Vec<String> = env::args().collect();
            let current_exe = env::current_exe().expect("Failed to get current exe path");
            
            // Re-run with sudo
            let status = Command::new("sudo")
                .arg(current_exe)
                .args(&args[1..])
                .status();
            
            match status {
                Ok(s) if s.success() => std::process::exit(0),
                _ => {
                    eprintln!("Failed to get root privileges. Application may not function correctly.");
                    // Continue anyway, but expect failure later
                }
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(VpnState {
            shutdown_tx: Mutex::new(None),
            current_ip: Mutex::new(None),
            socks5_port: Mutex::new(None),
            command_tx: Mutex::new(None),
            menu_connected: Mutex::new(None),
            menu_rules: Mutex::new(None),
            menu_global: Mutex::new(None),
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                use objc2::msg_send;
                
                if let Some(window) = app.get_webview_window("main") {
                    unsafe {
                        let ns_window = window.ns_window().unwrap() as *mut objc2::runtime::AnyObject;
                        
                        // 强制透明化逻辑
                        let _: () = msg_send![ns_window, setOpaque: false];
                        let _: () = msg_send![ns_window, setHasShadow: false];
                        
                        let cls = objc2::runtime::AnyClass::get("NSColor").unwrap();
                        let clear_color: *mut objc2::runtime::AnyObject = msg_send![cls, clearColor];
                        let _: () = msg_send![ns_window, setBackgroundColor: clear_color];
                    }
                    let _ = window.show();
                }
            }

            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            
            let connected_i = CheckMenuItem::with_id(app, "connected", "已连接", true, false, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            
            let mode_i = MenuItem::with_id(app, "mode_title", "代理规则", false, None::<&str>)?;
            
            // Rules and Global are mutually exclusive, but CheckMenuItem works fine. 
            // We will manage their state manually. Default to Rules (checked).
            let rules_i = CheckMenuItem::with_id(app, "mode_rules", "规则", true, true, None::<&str>)?;
            
            let global_i = CheckMenuItem::with_id(app, "mode_global", "全局", true, false, None::<&str>)?;
            
            // Re-using old menu items for now if needed, but based on image, we only need these + maybe quit?
            // The image doesn't show quit, but usually it's there. User said "托盘菜单做成图片这样的", 
            // but usually a quit is essential. I will keep quit at bottom as standard practice unless strictly forbidden.
            // The user input image shows: Show Main, Connected, [Separator], Outbound Mode (disabled), [Separator], Rules (Checked), [Separator], Global.
            // Wait, "Connected" is clickable? In previous prompt "连接/断开" was requested.
            // Image says "已连接" with a checkmark. This implies it's a status indicator or toggle.
            // Let's assume clicking "已连接" toggles connection.
            
            let sep_end = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            // Store items in state
            let state = app.state::<VpnState>();
            {
                let mut connected_lock = state.menu_connected.lock().unwrap();
                *connected_lock = Some(connected_i.clone());
            }
            {
                let mut rules_lock = state.menu_rules.lock().unwrap();
                *rules_lock = Some(rules_i.clone());
            }
            {
                let mut global_lock = state.menu_global.lock().unwrap();
                *global_lock = Some(global_i.clone());
            }

            let menu = Menu::with_items(app, &[
                &show_i,
                &sep1,
                &connected_i,
                &sep2,
                &mode_i,
                &rules_i,
                &global_i,
                &sep_end,
                &quit_i,
            ])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "quit" => {
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                println!("Quitting application, cleaning up...");
                                let state = app_handle.state::<VpnState>();
                                
                                // Send shutdown signal to VPN node if running
                                let tx = {
                                    let mut shutdown_tx = state.shutdown_tx.lock().unwrap();
                                    shutdown_tx.take()
                                };
                                if let Some(tx) = tx {
                                    let _ = tx.send(());
                                }
                                
                                // Ensure system proxy is disabled
                                let _ = set_system_proxy(false, 0).await;
                                
                                app_handle.exit(0);
                            });
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "connected" => {
                            // Toggle VPN
                            let _ = app.emit("toggle-vpn", ());
                            // Check state will be updated by backend event "vpn-connected"/"vpn-disconnected"
                        }
                        "mode_rules" => {
                            let _ = app.emit("set-proxy-mode", "rules");
                            // Update UI state immediately via State
                            let state = app.state::<VpnState>();
                            let _ = set_proxy_mode_menu(state, "rules".to_string());
                        }
                        "mode_global" => {
                            let _ = app.emit("set-proxy-mode", "global");
                            let state = app.state::<VpnState>();
                            let _ = set_proxy_mode_menu(state, "global".to_string());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_vpn, stop_vpn, get_hostname, get_system_info, update_services, set_system_proxy, get_vpn_status, quit_app, set_proxy_mode_menu])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

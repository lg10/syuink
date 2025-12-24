import { useState, useEffect } from "react";
import { Settings, Globe, ChevronDown, ChevronUp, Zap, Minus, Square, X, Power, Monitor } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVPN } from "../context/VPNContext";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

function Home() {
  const navigate = useNavigate();
  const { 
    isConnected, 
    status, 
    currentIp, 
    socks5Port,
    peers, 
    deviceName, 
    connect, 
    disconnect, 
    isLoading,
    isGlobalProxy,
    setGlobalProxy
  } = useVPN();

  const [showServices, setShowServices] = useState(false);
  const [services, setServices] = useState<any[]>([]);

  useEffect(() => {
    // Check login status
    const token = localStorage.getItem("syuink_user_token");
    if (!token) {
        navigate('/login');
    }

    const saved = localStorage.getItem("syuink_services");
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                setServices(parsed);
            }
        } catch(e) {}
    }
  }, [navigate]);

  useEffect(() => {
    // Listen for tray events
    let unlistenFn: (() => void) | undefined;
    
    import("@tauri-apps/api/event").then(async ({ listen }) => {
        const u1 = await listen('open-settings', () => openSettings());
        const u2 = await listen('open-devices', () => openDevices());
        const u3 = await listen('toggle-vpn', () => {
             console.log("Tray toggle triggered");
             document.getElementById('connect-btn')?.click();
        });
        
        // Listen for mode change requests from Tray
        const u4 = await listen('set-proxy-mode', (event) => {
            const mode = event.payload as string;
            console.log("Tray requested mode change:", mode);
            if (mode === 'global') {
                setGlobalProxy(true);
            } else if (mode === 'rules') {
                setGlobalProxy(false);
            }
        });
        
        unlistenFn = () => {
            u1();
            u2();
            u3();
            u4();
        };
    });

    return () => {
        if (unlistenFn) unlistenFn();
    };
  }, []); // Run once for setup? No, toggle needs fresh state. 
  // Actually, clicking the button via ID is a safe hack to avoid closure issues without complex Ref

  const handleToggle = () => {
      if (isConnected) {
          disconnect();
      } else {
          connect();
      }
  };

  const openSettings = async () => {
      console.log("Opening settings...");
      // Check if window exists
      try {
          const win = await WebviewWindow.getByLabel('settings');
          if (win) {
              console.log("Settings window exists, focusing");
              await win.setFocus();
              return;
          }
      } catch (e) {
          console.error("Error checking settings window:", e);
      }

      console.log("Creating new settings window");
      try {
        const webview = new WebviewWindow('settings', {
            url: '/#/settings',
            title: '设置',
            width: 600,
            height: 500,
            resizable: false,
            decorations: true,
            center: true
        });
        
        webview.once('tauri://created', function () {
            console.log('Settings window created');
        });
        
        webview.once('tauri://error', function (e) {
            console.error('Settings window creation error:', e);
        });
      } catch (e) {
          console.error("Failed to create settings window:", e);
      }
  };

  const openDevices = async () => {
      try {
          const win = await WebviewWindow.getByLabel('devices');
          if (win) {
              await win.setFocus();
              return;
          }
      } catch (e) {}

      const webview = new WebviewWindow('devices', {
          url: '/#/devices',
          title: '设备管理',
          width: 900,
          height: 700,
          decorations: true,
          center: true
      });
  };

  const appWindow = getCurrentWindow();

  const handleMinimize = async () => {
      // Close secondary windows first
      try {
          const settings = await WebviewWindow.getByLabel('settings');
          if (settings) await settings.close();
      } catch (e) {}
      
      try {
          const devices = await WebviewWindow.getByLabel('devices');
          if (devices) await devices.close();
      } catch (e) {}
      
      appWindow.minimize();
  };

  const handleClose = async () => {
      // Close secondary windows first
      try {
          const settings = await WebviewWindow.getByLabel('settings');
          if (settings) await settings.close();
      } catch (e) {}
      
      try {
          const devices = await WebviewWindow.getByLabel('devices');
          if (devices) await devices.close();
      } catch (e) {}

      // Hide to tray instead of quitting
      appWindow.hide();
  };

  return (
    <div style={{ 
      height: '100vh',
      width: '100vw',
      display: 'flex', 
      flexDirection: 'column', 
      backgroundColor: 'white',
      borderRadius: '16px',
      overflow: 'hidden',
      fontFamily: '"Microsoft YaHei", sans-serif',
      color: '#333',
      boxSizing: 'border-box',
      border: '1px solid rgba(0,0,0,0.05)'
    }}>
      
      {/* Title Bar / Drag Region */}
      <div data-tauri-drag-region style={{ 
          height: '40px', 
          display: 'flex', 
          justifyContent: 'flex-end', 
          alignItems: 'center', 
          paddingRight: '10px' 
      }}>
          <div style={{ display: 'flex', gap: '8px', zIndex: 9999 }}>
              <Minus size={18} color="#666" style={{ cursor: 'pointer' }} onClick={handleMinimize} />
              {/* Maximize usually not needed for this card style, but requested */}
              {/* <Square size={16} color="#666" style={{ cursor: 'pointer' }} onClick={() => appWindow.toggleMaximize()} /> */}
              <X size={18} color="#666" style={{ cursor: 'pointer' }} onClick={handleClose} />
          </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 20px' }}>
          
          {/* Title */}
          <h1 style={{ fontSize: '32px', fontWeight: 'bold', margin: '10px 0 5px 0' }}>Syu.ink</h1>
          <p style={{ color: '#999', fontSize: '14px', margin: '0 0 40px 0' }}>异地组网 · P2P 直连</p>

          {/* Status Icon */}
          <div style={{ marginBottom: '10px' }}>
              {isConnected ? (
                  <div style={{ 
                      width: '60px', height: '60px', borderRadius: '50%', 
                      backgroundColor: '#e6f7ea', display: 'flex', alignItems: 'center', justifyContent: 'center' 
                  }}>
                      <div style={{ fontSize: '30px', color: '#28a745' }}>✓</div>
                  </div>
              ) : (
                  <Zap size={48} style={{ fill: "url(#gradient)", stroke: "none" }} />
              )}
              {/* Gradient definition for the Zap icon */}
              <svg width="0" height="0">
                <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#ff9a44" />
                  <stop offset="100%" stopColor="#ff6b6b" />
                </linearGradient>
              </svg>
          </div>

          <div style={{ color: '#ccc', fontSize: '14px', marginBottom: '40px', textAlign: 'center' }}>
              <div>{isConnected ? "已连接" : "未连接"}</div>
              {isConnected && currentIp && (
                  <div style={{ fontSize: '12px', marginTop: '5px', color: '#1677ff', fontFamily: 'monospace' }}>
                      虚拟 IP: {currentIp} | SOCKS5 代理: 127.0.0.1:{socks5Port}
                  </div>
              )}
          </div>

          {/* Device Info */}
          <div style={{ fontSize: '14px', marginBottom: '20px', color: '#333' }}>
              当前设备: <span 
                  onClick={openDevices}
                  style={{ color: '#1677ff', fontWeight: 'bold', cursor: 'pointer', marginLeft: '5px' }}
              >
                  {deviceName || "Unknown"}
              </span>
          </div>

          {/* Connect Button */}
          <button 
              id="connect-btn"
              onClick={handleToggle}
              disabled={isLoading || !deviceName}
              style={{
                  width: '100%',
                  height: '50px',
                  backgroundColor: isConnected ? '#ff4d4f' : '#1677ff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  marginBottom: '15px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  opacity: (isLoading || !deviceName) ? 0.7 : 1
              }}
          >
              {isLoading ? "处理中..." : (isConnected ? "断开连接" : "一键连接")}
          </button>

          {/* Global Proxy Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '20px' }}>
             <span style={{ fontSize: '14px', color: '#666' }}>全局代理</span>
             <div 
                 onClick={() => setGlobalProxy(!isGlobalProxy)}
                 style={{
                     width: '40px',
                     height: '20px',
                     backgroundColor: isGlobalProxy ? '#1677ff' : '#ccc',
                     borderRadius: '10px',
                     position: 'relative',
                     cursor: 'pointer',
                     transition: 'background-color 0.3s'
                 }}
             >
                 <div style={{
                     width: '16px',
                     height: '16px',
                     backgroundColor: 'white',
                     borderRadius: '50%',
                     position: 'absolute',
                     top: '2px',
                     left: isGlobalProxy ? '22px' : '2px',
                     transition: 'left 0.3s'
                 }} />
             </div>
          </div>

          {/* Services Dropdown Pill */}
          <div style={{ width: '100%' }}>
              <div 
                  onClick={() => setShowServices(!showServices)}
                  style={{
                      backgroundColor: '#f5f5f5',
                      borderRadius: '8px',
                      padding: '12px 15px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      color: '#555',
                      fontSize: '14px'
                  }}
              >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Globe size={18} />
                      <span>共享服务 ({services.length})</span>
                  </div>
                  {showServices ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </div>

              {/* Service List (Collapsible) */}
              {showServices && (
                  <div style={{ 
                      marginTop: '10px', 
                      backgroundColor: '#fff', 
                      border: '1px solid #eee', 
                      borderRadius: '8px', 
                      padding: '10px',
                      fontSize: '12px',
                      maxHeight: '120px',
                      overflowY: 'auto'
                  }}>
                      {services.length === 0 ? (
                          <div style={{ color: '#999', textAlign: 'center' }}>暂无共享服务</div>
                      ) : (
                          services.map((s, i) => (
                              <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid #f0f0f0' }}>
                                  {s.ip}:{s.port} ({s.protocol})
                              </div>
                          ))
                      )}
                  </div>
              )}
          </div>

      </div>

      {/* Footer / Status Bar */}
      <div style={{ 
          padding: '15px 20px', 
          
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          position: 'relative',
          fontSize: '12px',
          color: '#999'
      }}>
          {/* Settings Button (Left) */}
          <div 
              onClick={openSettings}
              style={{ 
                  position: 'absolute', 
                  left: '20px', 
                  cursor: 'pointer',
                  padding: '5px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
              <Settings size={20} color="#666" />
          </div>

          {/* Status Text (Center) */}
          <div>
              状态: {status}
          </div>

          {/* Devices Button (Right) */}
          <div 
              onClick={openDevices}
              style={{ 
                  position: 'absolute', 
                  right: '20px', 
                  cursor: 'pointer',
                  padding: '5px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              title="设备管理"
          >
              <Monitor size={20} color="#666" />
          </div>
      </div>
    </div>
  );
}

export default Home;

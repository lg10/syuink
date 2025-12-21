import { useState, useEffect } from "react";
import { Settings, Users, Plus, Trash, Server, ChevronDown, ChevronUp, Globe } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVPN } from "../context/VPNContext";
import { invoke } from "@tauri-apps/api/core";

function Home() {
  console.log("Rendering Home Component");
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

  console.log("Home State:", { isConnected, status, currentIp, socks5Port, peersCount: peers?.length, deviceName, isLoading });

  const [showServices, setShowServices] = useState(false);
  const [services, setServices] = useState<any[]>([]);

  useEffect(() => {
    console.log("Home useEffect mounted");
    // Check login status
    const token = localStorage.getItem("syuink_user_token");
    if (!token) {
        console.log("No token found, redirecting to login");
        navigate('/login');
    }

    const saved = localStorage.getItem("syuink_services");
    console.log("Loaded services from localStorage:", saved);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                setServices(parsed);
            } else {
                setServices([]);
            }
        } catch(e) {
            console.error("Failed to parse services:", e);
            setServices([]);
        }
    }
  }, [navigate]);

  const saveServices = async (newServices: any[]) => {
      setServices(newServices);
      localStorage.setItem("syuink_services", JSON.stringify(newServices));
      if (isConnected) {
          try { await invoke("update_services", { services: newServices }); } catch(e){}
      }
  };

  const handleToggle = () => {
      if (isConnected) {
          disconnect();
      } else {
          connect();
      }
  };

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100%',
      fontFamily: '"Microsoft YaHei", sans-serif',
      backgroundColor: '#f0f2f5',
      color: '#333',
      position: 'relative'
    }}>
      
      {/* Top Right Settings Icon */}
      <div 
        style={{ position: 'absolute', top: '20px', right: '20px', cursor: 'pointer', color: '#666' }}
        onClick={() => navigate('/settings')}
      >
        <Settings size={24} />
      </div>

      <div style={{
        backgroundColor: 'white',
        padding: '40px',
        borderRadius: '12px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        textAlign: 'center',
        width: '320px'
      }}>
        <h1 style={{ margin: '0 0 10px 0', color: '#1a1a1a' }}>Syu.ink</h1>
        <p style={{ margin: '0 0 30px 0', color: '#666', fontSize: '14px' }}>异地组网 · P2P 直连</p>
        
        <div style={{ 
          marginBottom: '30px', 
          height: '100px', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center' 
        }}>
          {isConnected ? (
            <div style={{ color: '#28a745' }}>
              <div style={{ fontSize: '48px', marginBottom: '10px' }}>✓</div>
              <div style={{ fontWeight: 'bold' }}>{deviceName}</div>
              {currentIp ? (
                  <div style={{ fontSize: '14px', marginTop: '5px', fontFamily: 'monospace' }}>IP: {currentIp}</div>
              ) : (
                  <div style={{ fontSize: '12px', marginTop: '5px', color: '#999' }}>正在获取 IP...</div>
              )}
            </div>
          ) : (
             <div style={{ color: '#ccc' }}>
              <div style={{ fontSize: '48px', marginBottom: '10px' }}>⚡</div>
              <div>未连接</div>
            </div>
          )}
        </div>

        {!isConnected && (
            <div style={{ marginBottom: '20px', fontSize: '14px', color: '#666' }}>
                当前设备: <strong>{deviceName}</strong>
            </div>
        )}

        <button 
          style={{ 
            padding: '12px 0', 
            width: '100%',
            cursor: (isLoading || (!deviceName && !isConnected)) ? 'not-allowed' : 'pointer', 
            backgroundColor: isConnected ? '#dc3545' : '#007bff', 
            color: 'white', 
            border: 'none', 
            borderRadius: '6px',
            fontSize: '16px',
            fontWeight: 'bold',
            transition: 'background 0.2s',
            opacity: (isLoading || (!deviceName && !isConnected)) ? 0.6 : 1
          }}
          disabled={isLoading || (!deviceName && !isConnected)}
          onClick={handleToggle}
        >
          {isLoading ? "处理中..." : (isConnected ? "断开连接" : "一键连接")}
        </button>

        {isConnected && (
            <button
                onClick={() => navigate('/devices')}
                style={{
                    marginTop: '15px',
                    width: '100%',
                    padding: '10px',
                    backgroundColor: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '6px',
                    color: '#333',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                }}
            >
                <Users size={16} />
                设备管理 ({Array.isArray(peers) ? peers.length + 1 : 1})
            </button>
        )}

        {isConnected && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: '#555', backgroundColor: '#e9ecef', padding: '8px', borderRadius: '6px', textAlign: 'left' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>SOCKS5 代理:</strong>
                    <span style={{ fontFamily: 'monospace', background: '#fff', padding: '2px 6px', borderRadius: '4px' }}>127.0.0.1:{socks5Port}</span>
                </div>
                <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>配置此代理以实现 TCP 直连 (SSH, HTTP)</span>
                </div>
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #ddd', display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input 
                        type="checkbox" 
                        id="global_proxy" 
                        checked={isGlobalProxy} 
                        onChange={(e) => setGlobalProxy(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                     />
                     <label htmlFor="global_proxy" style={{ cursor: 'pointer', fontWeight: 'bold' }}>启用全局系统代理</label>
                </div>
            </div>
        )}

        {/* Service Management */}
        <div style={{ marginTop: '15px', width: '100%' }}>
            <div 
                onClick={() => setShowServices(!showServices)}
                style={{ 
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', 
                    padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '6px', 
                    cursor: 'pointer', fontSize: '14px', color: '#555'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Globe size={16} />
                    <span>共享服务 ({services.length})</span>
                </div>
                {showServices ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>

            {showServices && (
                <div style={{ 
                    marginTop: '5px', padding: '10px', backgroundColor: '#fff', 
                    border: '1px solid #eee', borderRadius: '6px', textAlign: 'left' 
                }}>
                    {/* List */}
                    <div style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '10px' }}>
                        {Array.isArray(services) && services.map((s, idx) => {
                            if (!s || typeof s !== 'object') return null;
                            const proto = typeof s.protocol === 'string' ? s.protocol : 'both';
                            return (
                                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '5px', paddingBottom: '5px', borderBottom: '1px solid #f0f0f0' }}>
                                    <div>
                                        <span style={{ fontWeight: 'bold' }}>{s.ip}:{s.port}</span>
                                        <span style={{ marginLeft: '5px', color: '#666', backgroundColor: '#eee', padding: '1px 4px', borderRadius: '3px', fontSize: '10px' }}>{proto.toUpperCase()}</span>
                                        <span style={{ marginLeft: '5px', color: '#888' }}>{s.service_type === 'printer' ? '打印机' : '通用'}</span>
                                    </div>
                                    <Trash size={14} color="#dc3545" style={{ cursor: 'pointer' }} onClick={() => {
                                        const next = [...services];
                                        next.splice(idx, 1);
                                        saveServices(next);
                                    }} />
                                </div>
                            );
                        })}
                        {services.length === 0 && <div style={{ color: '#999', fontSize: '12px', textAlign: 'center' }}>暂无共享服务</div>}
                    </div>

                    {/* Add Simple Form */}
                    <div style={{ display: 'flex', gap: '5px' }}>
                        <input id="quick_ip" placeholder="IP" style={{ width: '35%', padding: '4px', fontSize: '12px' }} />
                        <input id="quick_port" placeholder="Port" style={{ width: '20%', padding: '4px', fontSize: '12px' }} />
                        <select id="quick_proto" style={{ width: '20%', padding: '4px', fontSize: '12px' }}>
                            <option value="both">TCP/UDP</option>
                            <option value="tcp">TCP</option>
                            <option value="udp">UDP</option>
                        </select>
                        <select id="quick_type" style={{ width: '25%', padding: '4px', fontSize: '12px' }}>
                            <option value="generic">通用</option>
                            <option value="printer">打印机</option>
                        </select>
                        <button onClick={() => {
                            const ip = (document.getElementById('quick_ip') as HTMLInputElement).value;
                            const port = (document.getElementById('quick_port') as HTMLInputElement).value;
                            const proto = (document.getElementById('quick_proto') as HTMLSelectElement).value;
                            const type = (document.getElementById('quick_type') as HTMLSelectElement).value;
                            
                            if(ip && port) {
                                saveServices([...services, { 
                                    ip, 
                                    port: parseInt(port), 
                                    protocol: proto, 
                                    service_type: type, 
                                    description: '' 
                                }]);
                                (document.getElementById('quick_ip') as HTMLInputElement).value = '';
                                (document.getElementById('quick_port') as HTMLInputElement).value = '';
                            }
                        }} style={{ flex: 1, padding: '0', cursor: 'pointer', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px' }}>+</button>
                    </div>
                </div>
            )}
        </div>

        <div style={{ 
          marginTop: '20px', 
          fontSize: '12px', 
          color: '#888',
          borderTop: '1px solid #eee',
          paddingTop: '15px'
        }}>
          状态: {status}
        </div>
      </div>
    </div>
  );
}

export default Home;

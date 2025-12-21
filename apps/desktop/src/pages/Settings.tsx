import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getServerConfig, saveServerConfig } from "../utils/server";
import { ArrowLeft, Monitor, Server, User } from "lucide-react";

function Settings() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("basic");
  
  // State
  const [deviceName, setDeviceName] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("8787");
  const [useSsl, setUseSsl] = useState(false);
  
  const [isTestingServer, setIsTestingServer] = useState(false);
  const [serverStatus, setServerStatus] = useState("");

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    try {
        const savedName = localStorage.getItem("syuink_device_name");
        if (savedName) setDeviceName(savedName);

        const config = getServerConfig();
        setHost(config.host || "127.0.0.1");
        setPort(config.port || "8787");
        setUseSsl(!!config.useSsl);

        const savedUser = localStorage.getItem("syuink_user_email");
        if (savedUser) {
            setIsLoggedIn(true);
            setUserEmail(savedUser);
        } else {
            setActiveTab("server");
        }
    } catch (e) {
        console.error(e);
    }
  }, []);

  const handleSaveDeviceName = () => {
    localStorage.setItem("syuink_device_name", deviceName);
    alert("设备名称已保存");
  };

  const handleTestAndSaveServer = async () => {
    setIsTestingServer(true);
    setServerStatus("正在保存...");
    saveServerConfig({ host, port, useSsl });
    setServerStatus("设置已保存");
    setIsTestingServer(false);
  };

  const handleBack = () => {
      if (window.history.length > 1) {
          navigate(-1);
      } else {
          navigate('/');
      }
  };
  
  const handleLogout = () => {
      localStorage.removeItem("syuink_user_email");
      localStorage.removeItem("syuink_user_token");
      setIsLoggedIn(false);
      setUserEmail("");
      navigate('/login');
  };

  const renderContent = () => {
    switch (activeTab) {
      case "basic":
        return (
          <div>
            <h2 style={{ marginBottom: '20px' }}>基础设置</h2>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>电脑名称</label>
              <input 
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                style={{ width: '100%', padding: '8px', marginBottom: '10px' }}
              />
              <button onClick={handleSaveDeviceName} style={{ padding: '8px 16px', cursor: 'pointer' }}>保存</button>
            </div>
          </div>
        );
      case "server":
        return (
          <div>
            <h2 style={{ marginBottom: '20px' }}>服务器设置</h2>
            
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>服务器地址 (域名或IP)</label>
              <input 
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com"
                style={{ width: '100%', padding: '8px', marginBottom: '10px' }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>端口</label>
              <input 
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8787"
                style={{ width: '100%', padding: '8px', marginBottom: '10px' }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input 
                        type="checkbox"
                        checked={useSsl}
                        onChange={(e) => setUseSsl(e.target.checked)}
                    />
                    <span>启用 SSL (HTTPS/WSS)</span>
                </label>
            </div>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button 
                    onClick={handleTestAndSaveServer} 
                    disabled={isTestingServer}
                    style={{ padding: '8px 16px', cursor: 'pointer' }}
                >
                    {isTestingServer ? "保存中..." : "保存设置"}
                </button>
                <span style={{ fontSize: '12px', color: '#666' }}>{serverStatus}</span>
            </div>
          </div>
        );
      case "user":
        return (
          <div>
            <h2 style={{ marginBottom: '20px' }}>用户</h2>
            {isLoggedIn ? (
                <div>
                    <p>已登录: <strong>{userEmail}</strong></p>
                    <button onClick={handleLogout} style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>退出登录</button>
                </div>
            ) : (
                <div>
                    <p>尚未登录</p>
                    <button 
                        onClick={() => navigate('/login')} 
                        style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
                    >
                        去登录 / 注册
                    </button>
                </div>
            )}
          </div>
        );
      default:
        return <div>Unknown Tab: {activeTab}</div>;
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100%', fontFamily: '"Microsoft YaHei", sans-serif', backgroundColor: '#f9f9f9' }}>
      <div style={{ width: '200px', backgroundColor: 'white', borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px', borderBottom: '1px solid #eee', fontSize: '18px', fontWeight: 'bold', color: '#333' }}>
          设置
        </div>
        
        <div 
            style={{ padding: '15px 20px', cursor: 'pointer', backgroundColor: activeTab === 'basic' ? '#f0f7ff' : 'transparent', color: activeTab === 'basic' ? '#007bff' : '#333', display: 'flex', alignItems: 'center', gap: '10px' }}
            onClick={() => setActiveTab('basic')}
        >
            <Monitor size={18} /> 基础设置
        </div>
        <div 
            style={{ padding: '15px 20px', cursor: 'pointer', backgroundColor: activeTab === 'server' ? '#f0f7ff' : 'transparent', color: activeTab === 'server' ? '#007bff' : '#333', display: 'flex', alignItems: 'center', gap: '10px' }}
            onClick={() => setActiveTab('server')}
        >
            <Server size={18} /> 服务器设置
        </div>
        <div 
            style={{ padding: '15px 20px', cursor: 'pointer', backgroundColor: activeTab === 'user' ? '#f0f7ff' : 'transparent', color: activeTab === 'user' ? '#007bff' : '#333', display: 'flex', alignItems: 'center', gap: '10px' }}
            onClick={() => setActiveTab('user')}
        >
            <User size={18} /> 用户
        </div>
      </div>

      <div style={{ flex: 1, padding: '40px' }}>
        {renderContent()}
      </div>
    </div>
  );
}


export default Settings;

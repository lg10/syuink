import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Settings, Minus, X } from "lucide-react";
import { getHttpBaseUrl } from "../utils/server";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

function Login() {
  const navigate = useNavigate();
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const appWindow = getCurrentWindow();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    // Get server URL from settings
    const httpUrl = getHttpBaseUrl();
    const endpoint = isLoginMode ? "/api/login" : "/api/register";
    
    try {
        const res = await fetch(`${httpUrl}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            if (isLoginMode) {
                // Login success
                localStorage.setItem("syuink_user_email", data.email);
                localStorage.setItem("syuink_user_token", data.token); // This is user_id
                // alert("登录成功"); // Removing alert for smoother UX
                navigate('/');
            } else {
                // Register success
                alert("注册成功，请登录");
                setIsLoginMode(true);
            }
        } else {
            alert("操作失败: " + (data.message || JSON.stringify(data)));
        }
    } catch (err) {
        console.error(err);
        alert("网络错误: " + err);
    } finally {
        setIsLoading(false);
    }
  };

  const openSettings = async () => {
      try {
          const win = await WebviewWindow.getByLabel('settings');
          if (win) {
              await win.setFocus();
              return;
          }
      } catch (e) {}

      const webview = new WebviewWindow('settings', {
          url: '/#/settings',
          title: '设置',
          width: 600,
          height: 500,
          resizable: false,
          decorations: true,
          center: true
      });
  };

  return (
    <div style={{ 
        height: '100vh',
        display: 'flex', 
        flexDirection: 'column', 
        backgroundColor: 'white', // White background for the card look
        borderRadius: '12px',
        overflow: 'hidden',
        fontFamily: '"Microsoft YaHei", sans-serif',
        border: '1px solid #e0e0e0',
        boxSizing: 'border-box'
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
              <Minus size={18} color="#666" style={{ cursor: 'pointer' }} onClick={() => appWindow.minimize()} />
              <X size={18} color="#666" style={{ cursor: 'pointer' }} onClick={() => appWindow.close()} />
          </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 20px' }}>
        
        {/* Settings Icon */}
        <div 
            style={{ position: 'absolute', top: '50px', right: '20px', cursor: 'pointer', color: '#ccc' }}
            onClick={openSettings}
        >
            <Settings size={20} />
        </div>

        <h2 style={{ textAlign: 'center', marginBottom: '30px', fontSize: '24px', fontWeight: 'bold' }}>
            {isLoginMode ? "Syu.ink 登录" : "注册账号"}
        </h2>
        
        <form onSubmit={handleSubmit} style={{ width: '100%' }}>
            <div style={{ marginBottom: '15px' }}>
                <input 
                    type="email" 
                    placeholder="邮箱"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ 
                        width: '100%', padding: '12px', borderRadius: '8px', 
                        border: '1px solid #eee', backgroundColor: '#f9f9f9',
                        boxSizing: 'border-box', outline: 'none'
                    }}
                />
            </div>
            <div style={{ marginBottom: '25px' }}>
                <input 
                    type="password" 
                    placeholder="密码"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ 
                        width: '100%', padding: '12px', borderRadius: '8px', 
                        border: '1px solid #eee', backgroundColor: '#f9f9f9',
                        boxSizing: 'border-box', outline: 'none'
                    }}
                />
            </div>
            
            <button 
                type="submit" 
                disabled={isLoading}
                style={{ 
                    width: '100%', padding: '12px', 
                    backgroundColor: '#1677ff', color: 'white', 
                    border: 'none', borderRadius: '8px', 
                    fontSize: '16px', fontWeight: 'bold',
                    cursor: 'pointer', opacity: isLoading ? 0.7 : 1 
                }}
            >
                {isLoading ? "处理中..." : (isLoginMode ? "登录" : "注册")}
            </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '14px' }}>
            <span style={{ color: '#999' }}>{isLoginMode ? "没有账号？" : "已有账号？"}</span>
            <span 
                style={{ color: '#1677ff', cursor: 'pointer', marginLeft: '5px' }}
                onClick={() => setIsLoginMode(!isLoginMode)}
            >
                {isLoginMode ? "去注册" : "去登录"}
            </span>
        </div>
      </div>
    </div>
  );
}

export default Login;

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Settings } from "lucide-react";
import { getHttpBaseUrl } from "../utils/server";

function Login() {
  const navigate = useNavigate();
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

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
                alert("登录成功");
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', fontFamily: '"Microsoft YaHei", sans-serif', backgroundColor: '#f0f2f5', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      
      {/* Top Right Settings */}
      <div 
        style={{ position: 'absolute', top: '20px', right: '20px', cursor: 'pointer', color: '#666' }}
        onClick={() => navigate('/settings')}
      >
        <Settings size={24} />
      </div>

      <div style={{ backgroundColor: 'white', padding: '40px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', width: '320px' }}>
        <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>{isLoginMode ? "登录 Syuink" : "注册账号"}</h2>
        
        <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>邮箱</label>
                <input 
                    type="email" 
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                />
            </div>
            <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>密码</label>
                <input 
                    type="password" 
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                />
            </div>
            
            <button 
                type="submit" 
                disabled={isLoading}
                style={{ width: '100%', padding: '12px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', opacity: isLoading ? 0.7 : 1 }}
            >
                {isLoading ? "处理中..." : (isLoginMode ? "登录" : "注册")}
            </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '14px' }}>
            <span style={{ color: '#666' }}>{isLoginMode ? "没有账号？" : "已有账号？"}</span>
            <span 
                style={{ color: '#007bff', cursor: 'pointer', marginLeft: '5px' }}
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

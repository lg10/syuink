import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Monitor, Wifi, Server, Smartphone, Laptop, Clock } from "lucide-react";
import { useVPN } from "../context/VPNContext";

const formatDuration = (start?: number) => {
    if (!start) return "刚刚";
    const diff = Math.max(0, Date.now() - start);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins} 分钟`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours} 小时 ${remainMins} 分钟`;
};

function Devices() {
  const navigate = useNavigate();
  const { peers, currentIp, deviceName, nodeId, isConnected, refreshPeers, connectedAt, isGlobalProxy, setGlobalProxy } = useVPN();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 60000); // Update every minute
      return () => clearInterval(timer);
  }, []);

  useEffect(() => {
      if (isConnected) {
          refreshPeers();
      }
      
      const interval = setInterval(() => {
          if (isConnected) {
              refreshPeers();
          }
      }, 5000); // Poll every 5 seconds
      
      return () => clearInterval(interval);
  }, [isConnected]);

  if (!isConnected) {
      return (
          <div style={{ padding: '40px', textAlign: 'center' }}>
              <h2>未连接</h2>
              <p>请先连接到网络查看设备</p>
          </div>
      )
  }

  // Calculate self gateway status
  const selfServicesStr = localStorage.getItem("syuink_services");
  const isSelfGateway = selfServicesStr ? JSON.parse(selfServicesStr).length > 0 : false;

  // Combine self + peers
  const allDevices = [
      { 
          id: nodeId || 'self', 
          name: deviceName + ' (我)', 
          ip: currentIp, 
          isSelf: true,
          is_gateway: isSelfGateway,
          os: "Windows", // Assuming current context, ideally get from invoke
          version: "",
          device_type: "desktop",
          connected_at: connectedAt
      },
      ...peers
  ];

  const getDeviceIcon = (type?: string) => {
      if (type === 'mobile') return <Smartphone size={24} />;
      return <Laptop size={24} />;
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#f9f9f9', fontFamily: '"Microsoft YaHei", sans-serif' }}>
      
      {/* Header */}
      <div style={{ padding: '20px', backgroundColor: 'white', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '20px' }}>设备管理 ({allDevices.length})</h1>
      </div>

      {/* List */}
      <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
            {allDevices.map((device) => (
                <div key={device.id} style={{ 
                    backgroundColor: 'white', 
                    borderRadius: '10px', 
                    padding: '20px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                    border: device.isSelf ? '2px solid #007bff' : '1px solid #eee'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                        <div style={{ backgroundColor: '#f0f7ff', padding: '10px', borderRadius: '8px', color: '#007bff' }}>
                            {device.is_gateway ? <Server size={24} color="#28a745" /> : getDeviceIcon(device.device_type)}
                        </div>
                        <div style={{ display: 'flex', gap: '5px' }}>
                            {device.is_gateway && (
                                <span style={{ backgroundColor: '#28a745', color: 'white', fontSize: '12px', padding: '2px 8px', borderRadius: '10px' }}>主服务</span>
                            )}
                            {device.isSelf && (
                                <span style={{ backgroundColor: '#007bff', color: 'white', fontSize: '12px', padding: '2px 8px', borderRadius: '10px' }}>本机</span>
                            )}
                        </div>
                    </div>
                    
                    <h3 style={{ margin: '0 0 5px 0', fontSize: '16px' }}>{device.name}</h3>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#666', fontSize: '14px', marginBottom: '10px' }}>
                        <Wifi size={14} />
                        <span style={{ fontFamily: 'monospace' }}>{device.ip}</span>
                    </div>

                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '5px', display: 'flex', gap: '10px' }}>
                        <span>{device.os || 'Unknown OS'} {device.version}</span>
                    </div>

                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Clock size={12} />
                        <span>已连接: {formatDuration(device.connected_at)}</span>
                    </div>

                    <div style={{ fontSize: '12px', color: '#999' }}>
                        ID: {device.id.substring(0, 12)}...
                    </div>
                </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export default Devices;

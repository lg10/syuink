import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getHttpBaseUrl, getWsBaseUrl } from "../utils/server";

export interface PeerInfo {
    id: string;
    ip: string;
    name: string;
    os?: string;
    version?: string;
    device_type?: string;
    is_gateway?: boolean;
    connected_at?: number;
    isSelf?: boolean;
}

interface VPNContextType {
    isConnected: boolean;
    status: string;
    currentIp: string;
    socks5Port: number;
    peers: PeerInfo[];
    nodeId: string;
    deviceName: string;
    deviceOs: string;
    deviceVersion: string;
    setDeviceName: (name: string) => void;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    isLoading: boolean;
    refreshPeers: () => Promise<void>;
    isGlobalProxy: boolean;
    setGlobalProxy: (enable: boolean) => Promise<void>;
    connectedAt?: number;
}

const VPNContext = createContext<VPNContextType | undefined>(undefined);

export function VPNProvider({ children }: { children: ReactNode }) {
    console.log("VPNProvider Rendering");
    const [isConnected, setIsConnected] = useState(false);
    const [status, setStatus] = useState("未连接");
    const [currentIp, setCurrentIp] = useState("");
    const [socks5Port, setSocks5Port] = useState(0);
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    const [deviceName, setDeviceName] = useState("");
    const [deviceOs, setDeviceOs] = useState("");
    const [deviceVersion, setDeviceVersion] = useState("");
    const [nodeId, setNodeId] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isGlobalProxy, setIsGlobalProxy] = useState(false);
    const [connectedAt, setConnectedAt] = useState<number | undefined>(undefined);

    // Initialize Device Name and ID
    useEffect(() => {
        // Ensure Device ID exists FIRST
        let nid = localStorage.getItem("syuink_node_id");
        if (!nid) {
             // Generate a simple UUID-like string
             nid = crypto.randomUUID();
             localStorage.setItem("syuink_node_id", nid);
        }
        setNodeId(nid);

        // Fetch System Info (Hostname, OS, Version)
        invoke("get_system_info").then((info: any) => {
            setDeviceOs(info.os);
            setDeviceVersion(info.version);
            
            const savedName = localStorage.getItem("syuink_device_name");
            if (savedName) {
                setDeviceName(savedName);
            } else {
                setDeviceName(info.hostname);
                localStorage.setItem("syuink_device_name", info.hostname);
            }
        }).catch(err => {
            console.error("Failed to get system info:", err);
            // Fallback for name if get_system_info fails
            const savedName = localStorage.getItem("syuink_device_name");
            if (savedName) {
                setDeviceName(savedName);
            } else {
                invoke("get_hostname").then((name) => {
                    setDeviceName(name as string);
                    localStorage.setItem("syuink_device_name", name as string);
                }).catch(console.error);
            }
        });
        
        // Load Global Proxy state
        const savedProxy = localStorage.getItem("syuink_global_proxy");
        if (savedProxy === "true") {
            setIsGlobalProxy(true);
            invoke("set_proxy_mode_menu", { mode: "global" }).catch(console.error);
        } else {
            invoke("set_proxy_mode_menu", { mode: "rules" }).catch(console.error);
        }

        // Sync state from backend (for multi-window support)
        invoke("get_vpn_status").then((res) => {
            const statusStr = res as string;
            if (statusStr && statusStr.includes("|")) {
                const parts = statusStr.split('|');
                const ip = parts[0];
                const portStr = parts[1];
                const port = parseInt(portStr);
                
                if (ip && !isNaN(port)) {
                    console.log("Synced VPN state from backend:", ip, port);
                    setCurrentIp(ip);
                    setSocks5Port(port);
                    setStatus("已连接到网络");
                    setIsConnected(true);
                    setConnectedAt(Date.now()); // Approximate, backend doesn't store time yet
                }
            }
        }).catch(console.error);
    }, []);

    // Listen for Backend Events
    useEffect(() => {
        console.log("VPNProvider: Setting up event listeners");
        const unlistenConnected = listen('vpn-connected', (event) => {
            console.log("VPN Connected Event:", event.payload);
            const statusStr = event.payload as string;
            if (statusStr && statusStr.includes("|")) {
                const parts = statusStr.split('|');
                const ip = parts[0];
                const portStr = parts[1];
                const port = parseInt(portStr);
                
                if (ip && !isNaN(port)) {
                    setCurrentIp(ip);
                    setSocks5Port(port);
                    setStatus("已连接到网络");
                    setIsConnected(true);
                    setConnectedAt(Date.now());
                }
            }
        });

        const unlistenDisconnected = listen('vpn-disconnected', () => {
            console.log("VPN Disconnected Event");
            setStatus("VPN 服务已停止");
            setIsConnected(false);
            setCurrentIp("");
            setSocks5Port(0);
            setPeers([]);
            setConnectedAt(undefined);
        });

        const unlistenPeers = listen('peers-updated', (event) => {
            console.log("Peers updated:", event.payload);
            const list = event.payload as PeerInfo[];
            if (Array.isArray(list)) {
                // Filter out self if ID matches
                const nid = localStorage.getItem("syuink_node_id");
                const filtered = list.filter(p => p.id !== nid);
                setPeers(filtered);
            } else {
                setPeers([]);
            }
        });

        return () => {
            unlistenConnected.then(f => f());
            unlistenDisconnected.then(f => f());
            unlistenPeers.then(f => f());
        };
    }, []);

    const refreshPeers = async () => {
        const token = localStorage.getItem("syuink_user_token");
        if (!token) return;

        // Get server URL from settings
        const httpUrl = getHttpBaseUrl();
        // Group ID is the token (user_id) in our current implementation
        const url = `${httpUrl}/api/group/${token}/devices`;

        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                console.log("Refreshed peers from API:", data);
                // Filter out self
                const nid = localStorage.getItem("syuink_node_id");
                const filtered = (data as PeerInfo[]).filter(p => p.id !== nid);
                setPeers(filtered);
            }
        } catch (e) {
            console.error("Failed to refresh peers:", e);
        }
    };

    const connect = async () => {
        if (isLoading || isConnected) return;
        setIsLoading(true);
        try {
            setStatus("正在初始化虚拟网络接口...");
            
            const serverUrl = getWsBaseUrl();
            const token = localStorage.getItem("syuink_user_token");
            
            const savedServices = localStorage.getItem("syuink_services");
            const services = savedServices ? JSON.parse(savedServices) : [];
            let nodeId = localStorage.getItem("syuink_node_id");
            if (!nodeId) {
                nodeId = crypto.randomUUID();
                localStorage.setItem("syuink_node_id", nodeId);
            }
            
            // Auto-detect gateway mode
            const isGateway = services.length > 0;

            // Allocate unique IP from server
            let allocatedIp = null;
            try {
                const httpUrl = getHttpBaseUrl();
                const ipRes = await fetch(`${httpUrl}/api/group/${token}/allocate_ip`);
                if (ipRes.ok) {
                    const ipData = await ipRes.json();
                    allocatedIp = ipData.ip;
                    console.log("Allocated IP from server:", allocatedIp);
                }
            } catch (e) {
                console.warn("Failed to allocate IP from server, falling back to local auto-discovery:", e);
            }

            const res = await invoke("start_vpn", { 
                ip: allocatedIp, 
                deviceName: deviceName,
                nodeId: nodeId,
                token: token,
                serverUrl: serverUrl,
                isGateway: isGateway,
                services: services
            }) as string;
            
            console.log("VPN Started result raw:", res);
            
            if (typeof res !== 'string') {
                throw new Error("Invalid response type: " + typeof res);
            }

            const parts = res.split('|');
            const ip = parts[0];
            const portStr = parts[1];
            const port = parseInt(portStr);

            if (!ip || isNaN(port)) {
                console.error("Parse failed. IP:", ip, "PortStr:", portStr);
                throw new Error(`Invalid response format: ${res}`);
            }

            setCurrentIp(ip);
            setSocks5Port(port);
            setStatus("已连接到网络");
            setIsConnected(true); 
            setConnectedAt(Date.now());

            // Restore global proxy setting if it was enabled
            if (isGlobalProxy) {
                await invoke("set_system_proxy", { enable: true, port: port });
            }
        } catch (e) {
            console.error(e);
            setStatus("连接失败: " + e);
            setIsConnected(false);
        } finally {
            setIsLoading(false);
        }
    };

    const disconnect = async () => {
        if (isLoading || !isConnected) return;
        setIsLoading(true);
        try {
            setStatus("正在断开...");
            const msg = await invoke("stop_vpn");
            setStatus(msg as string);
            setIsConnected(false);
            setCurrentIp("");
            setSocks5Port(0);
            setPeers([]);
            setConnectedAt(undefined);
        } catch (e) {
            console.error(e);
            setStatus("断开失败: " + e);
        } finally {
            setIsLoading(false);
        }
    };

    const setGlobalProxy = async (enable: boolean) => {
        // Save preference immediately
        localStorage.setItem("syuink_global_proxy", enable.toString());
        setIsGlobalProxy(enable);
        
        // Sync Menu UI
        invoke("set_proxy_mode_menu", { mode: enable ? "global" : "rules" }).catch(console.error);

        if (isConnected && socks5Port > 0) {
            try {
                await invoke("set_system_proxy", { enable: enable, port: socks5Port });
            } catch (e) {
                console.error("Failed to set system proxy:", e);
                // Revert state if failed? For now, keep preference but alert user
                // alert("设置全局代理失败: " + e); 
            }
        }
    };

    return (
        <VPNContext.Provider value={{
            isConnected,
            status,
            currentIp,
            socks5Port,
            peers,
            deviceName,
            deviceOs,
            deviceVersion,
            nodeId,
            setDeviceName,
            connect,
            disconnect,
            isLoading,
            refreshPeers,
            isGlobalProxy,
            setGlobalProxy,
            connectedAt
        }}>
            {children}
        </VPNContext.Provider>
    );
}

export function useVPN() {
    const context = useContext(VPNContext);
    if (context === undefined) {
        throw new Error('useVPN must be used within a VPNProvider');
    }
    return context;
}

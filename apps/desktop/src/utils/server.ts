export interface ServerConfig {
    host: string;
    port: string;
    useSsl: boolean;
}

const DEFAULT_CONFIG: ServerConfig = {
    host: "signal.syu.ink",
    port: "", // Empty means use default port for protocol (443 for HTTPS)
    useSsl: true,
};

export function getServerConfig(): ServerConfig {
    const host = localStorage.getItem("syuink_server_host");
    // port can be empty string, so check for null
    const port = localStorage.getItem("syuink_server_port");
    const useSsl = localStorage.getItem("syuink_server_ssl");

    // Compatibility: If new settings don't exist but old url does, try to parse it
    if (host === null && port === null) {
        const oldUrl = localStorage.getItem("syuink_server_url");
        if (oldUrl) {
            try {
                // Handle ws:// prefix for parsing
                const urlStr = oldUrl.startsWith("http") ? oldUrl : oldUrl.replace("ws", "http");
                const url = new URL(urlStr);
                return {
                    host: url.hostname,
                    port: url.port, // URL.port is empty string if default
                    useSsl: url.protocol === 'https:' || url.protocol === 'wss:',
                };
            } catch (e) {
                // Ignore parse error
            }
        }
        // If no old settings, return default
        return DEFAULT_CONFIG;
    }

    return {
        host: host !== null ? host : DEFAULT_CONFIG.host,
        port: port !== null ? port : DEFAULT_CONFIG.port,
        useSsl: useSsl !== null ? useSsl === "true" : DEFAULT_CONFIG.useSsl,
    };
}

export function saveServerConfig(config: ServerConfig) {
    localStorage.setItem("syuink_server_host", config.host);
    localStorage.setItem("syuink_server_port", config.port);
    localStorage.setItem("syuink_server_ssl", String(config.useSsl));
    
    // Clear old key to avoid confusion
    localStorage.removeItem("syuink_server_url");
}

export function getHttpBaseUrl(): string {
    const config = getServerConfig();
    const protocol = config.useSsl ? "https" : "http";
    // If port is empty, don't include it (standard ports)
    const portPart = config.port ? `:${config.port}` : "";
    return `${protocol}://${config.host}${portPart}`;
}

export function getWsBaseUrl(): string {
    const config = getServerConfig();
    const protocol = config.useSsl ? "wss" : "ws";
    const portPart = config.port ? `:${config.port}` : "";
    return `${protocol}://${config.host}${portPart}`;
}

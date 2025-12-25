export interface Env {
	SIGNAL_ROOM: DurableObjectNamespace;
	DB: D1Database;
}

const INIT_USERS_SQL = "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);";

const INIT_DEVICES_SQL = "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Initialize DB on first access (cheap check)
        // Execute separately to avoid SQLite batch execution issues in some drivers
		try {
            await env.DB.exec(INIT_USERS_SQL);
            await env.DB.exec(INIT_DEVICES_SQL);
        } catch (e) {
            console.error("DB Init Error (Non-fatal if tables exist):", e);
        }

		const url = new URL(request.url);
		
		// Enable CORS
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
                    "Access-Control-Max-Age": "86400",
				}
			});
		}

		// API Routes
		if (url.pathname === "/api/register" && request.method === "POST") {
			return await handleRegister(request, env);
		}
		if (url.pathname === "/api/login" && request.method === "POST") {
			return await handleLogin(request, env);
		}

		// WebSocket Route & Group Management
		if (url.pathname.startsWith('/wapi/') || url.pathname.startsWith('/api/group/')) {
			// Extract Token or Group ID
			// For WS: /wapi/
			// For API: /api/group/:groupId/devices
			
			let groupId = "";
			
			if (url.pathname.startsWith('/wapi/')) {
				const token = url.searchParams.get('token');
				if (!token) {
                    console.error("[WS] Connection rejected: Missing token");
                    return new Response('Unauthorized: Token required', { status: 401 });
                }
				
				// Validate user
				const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token).first();
				if (!user) {
                    console.error(`[WS] Connection rejected: Invalid token ${token}`);
                    return new Response('Unauthorized: Invalid Token', { status: 401 });
                }
				
				groupId = user.id as string;
                console.log(`[WS] Resolved GroupID: ${groupId} from Token: ${token}`);
			} else {
				// API Access
				// In real app, we should validate Authorization header here
				const parts = url.pathname.split('/');
				if (parts[2] === 'group') {
					groupId = parts[3];
                    console.log(`[API] Resolved GroupID: ${groupId} from /api/group/ URL: ${url.pathname}`);
				} else {
                    console.warn(`[API] Path not recognized: ${url.pathname}`);
					return new Response('Not Found', { status: 404 });
				}

			}

            if (!groupId) {
                console.error(`[DO] Could not resolve groupId for path: ${url.pathname}`);
                return new Response('Group not found', { status: 404 });
            }

		// Forward to DO
		const id = env.SIGNAL_ROOM.idFromName(groupId);
        console.log(`[DO] Forwarding ${request.method} ${url.pathname} to Room ID: ${id.toString()} (Group: ${groupId})`);
		const obj = env.SIGNAL_ROOM.get(id);

		return obj.fetch(request);

		}

		return new Response('Syuink Signaling Server Running', { 
			status: 200,
			headers: { "Access-Control-Allow-Origin": "*" }
		});
	},
};

// ... (Register/Login handlers remain same, omitted for brevity but should be included)
async function handleRegister(request: Request, env: Env): Promise<Response> {
	try {
		const { email, password } = await request.json() as any;
		if (!email || !password) return new Response("Missing fields", { status: 400 });

		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
		).bind(id, email, password, Date.now()).run();

		return new Response(JSON.stringify({ id, email }), { 
			status: 201,
			headers: { "Access-Control-Allow-Origin": "*" }
		});
	} catch (e: any) {
		return new Response("Error: " + e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
	}
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	try {
		const { email, password } = await request.json() as any;
		const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
		
		if (!user || user.password_hash !== password) {
			return new Response("Invalid credentials", { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
		}

		return new Response(JSON.stringify({ 
			token: user.id, 
			email: user.email 
		}), { 
			headers: { "Access-Control-Allow-Origin": "*" }
		});
	} catch (e: any) {
		return new Response("Error: " + e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
	}
}

// Durable Object
export class SignalRoom {
	state: DurableObjectState;
	// Store metadata with the socket
	sessions: Map<WebSocket, { 
        id?: string, 
        ip?: string, 
        public_addr?: string,
        p2p_port?: number,
        name?: string, 
        os?: string, 
        version?: string, 
        device_type?: string, 
        is_gateway?: boolean,
        connected_at?: number,
        replaced?: boolean 
    }>;
	services: Map<string, any[]>; // PeerID -> List of ServiceDecl
    ipLeases: Map<string, { id?: string, ts: number }>; // ip -> lease info

    private clamp(val: any, maxLen = 128) {
        if (typeof val !== 'string') return '';
        return val.slice(0, maxLen);
    }

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.sessions = new Map();
		this.services = new Map();
        this.ipLeases = new Map();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
        
        // Helper to add CORS to all DO responses
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

		// Handle API request to list devices
        const leaseTtlMs = 10 * 60 * 1000;
		const parts = url.pathname.split('/');
		
        // For /api/group/:groupId/devices -> parts is ["", "api", "group", "{groupId}", "devices"]
        // For /wapi/{groupId} -> parts is ["", "wapi", "{groupId}"]
        let groupIdFromPath = "";
        if (url.pathname.includes('/api/group/')) {
            groupIdFromPath = parts[3] || "";
        } else if (url.pathname.startsWith('/wapi/')) {
            groupIdFromPath = parts[2] || "";
        }

		const authHeader = request.headers.get('Authorization') || '';
		const token = authHeader.replace('Bearer ', '').trim();
        
        // Validation: For API calls, ensure token matches groupId
        // WS connections are already validated by the main fetch handler before forwarding
        const isWsUpgrade = request.headers.get('Upgrade') === 'websocket';
        const authorized = isWsUpgrade || (!!groupIdFromPath && token === groupIdFromPath);

        if (!isWsUpgrade) {
            console.log(`[DO Auth] Path: ${url.pathname}, Group: ${groupIdFromPath}, Token: ${token ? 'present' : 'missing'}, Authorized: ${authorized}`);
        }

        const pruneLeases = () => {
            const now = Date.now();
            let count = 0;
            for (const [ip, lease] of this.ipLeases) {
                if (now - lease.ts > leaseTtlMs) {
                    this.ipLeases.delete(ip);
                    count++;
                }
            }
            if (count > 0) console.log(`[DO Lease] Pruned ${count} expired leases`);
        };

		if (url.pathname.endsWith('/devices')) {
            if (!authorized) {
                console.warn(`[API] Unauthorized /devices. Expected Bearer ${groupIdFromPath}, got ${authHeader}`);
                return new Response('Unauthorized', { status: 401, headers: corsHeaders });
            }
			const devices = [];
			for (const [_, meta] of this.sessions) {
				if (meta.id) devices.push(meta);
			}
			return new Response(JSON.stringify(devices), {
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}

		if (url.pathname.endsWith('/allocate_ip')) {
            if (!authorized) {
                console.warn(`[API] Unauthorized /allocate_ip. Expected Bearer ${groupIdFromPath}, got ${authHeader}`);
                return new Response('Unauthorized', { status: 401, headers: corsHeaders });
            }
            pruneLeases();
			const usedIps = new Set<string>();
			for (const [_, meta] of this.sessions) {
				if (meta.ip) usedIps.add(meta.ip);
			}
            for (const [ip, lease] of this.ipLeases) {
                usedIps.add(ip);
            }
			
			let allocated = "";
			for (let i = 2; i < 255; i++) {
				const candidate = `10.251.0.${i}`;
				if (!usedIps.has(candidate)) {
					allocated = candidate;
                    this.ipLeases.set(candidate, { id: `lease:${groupIdFromPath}`, ts: Date.now() });
					break;
				}
			}
            
            console.log(`[API] Allocated IP: ${allocated} for group: ${groupIdFromPath}`);
			
			if (!allocated) return new Response('No available IPs', { status: 507, headers: corsHeaders });
			
			return new Response(JSON.stringify({ ip: allocated }), {
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}


		// Handle WebSocket Upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

        const xForwardedFor = request.headers.get('X-Forwarded-For')?.split(',')[0].trim();
        const xRealIp = request.headers.get('X-Real-IP');
        const cfIp = request.headers.get('CF-Connecting-IP');

        let publicAddr = 'unknown';

        // 优先级逻辑：优先信任 Nginx 转发的真实 IP
        // 如果 X-Forwarded-For 存在且不是内网 IP，优先使用它
        if (xForwardedFor && !xForwardedFor.startsWith('172.') && !xForwardedFor.startsWith('10.') && !xForwardedFor.startsWith('192.168.')) {
            publicAddr = xForwardedFor;
        } else if (xRealIp && !xRealIp.startsWith('172.') && !xRealIp.startsWith('10.') && !xRealIp.startsWith('192.168.')) {
            publicAddr = xRealIp;
        } else {
            // 如果前面的都不行，再尝试 CF 或原始字段
            publicAddr = xForwardedFor || xRealIp || cfIp || 'unknown';
        }

		server.accept();

		this.sessions.set(server, { public_addr: publicAddr }); // Store public addr initially
		console.log(`New WebSocket connection from ${publicAddr}. (Raw CF: ${cfIp}, XFF: ${xForwardedFor}). Total sessions:`, this.sessions.size);

		server.addEventListener('message', (event) => {
			this.handleMessage(server, event.data);
		});

		server.addEventListener('close', () => {
            try {
                const meta = this.sessions.get(server);
                if (meta && meta.id && !meta.replaced) {
                    // Broadcast peer_left
                    this.broadcast({
                        type: 'peer_left',
                        id: meta.id
                    }, server);

                    // Remove services and update
                    if (this.services.has(meta.id)) {
                        this.services.delete(meta.id);
                        this.broadcastServiceUpdate();
                    }
                }
                // Release IP lease
                if (meta && meta.ip && this.ipLeases.has(meta.ip)) {
                    this.ipLeases.delete(meta.ip);
                }
                this.sessions.delete(server);
                console.log('WebSocket connection closed. Total sessions:', this.sessions.size);
            } catch (e) {
                console.error("Error in close handler:", e);
            }
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	handleMessage(sender: WebSocket, data: any) {
		try {
			const msgStr = data as string;
			const msg = JSON.parse(msgStr);
			
			// Handle Service Registration
			if (msg.type === 'register_services') {
				const senderId = msg.id;
				const newServices = msg.services; // Array of ServiceDecl

                const ipRegex = /^\d{1,3}(?:\.\d{1,3}){3}$/;

                const normalizeProtocol = (p: string) => {
                    if (!p) return '';
                    const val = (p as string).toLowerCase();
                    if (val === 'tcp' || val === 'udp' || val === 'both') return val;
                    return '';
                };

				let conflict = false;
                let invalid = false;
				for (const newSvc of newServices) {
                    // basic validation
                    if (!newSvc || !newSvc.ip || !ipRegex.test(newSvc.ip)) { invalid = true; break; }
                    if (!newSvc.port || newSvc.port < 1 || newSvc.port > 65535) { invalid = true; break; }
                    const proto = normalizeProtocol(newSvc.protocol);
                    if (!proto) { invalid = true; break; }
                    newSvc.protocol = proto;

                    // conflict detection: any existing same ip+port regardless protocol
					for (const [pid, svcs] of this.services) {
						if (pid === senderId) continue;
						for (const existing of svcs) {
							const exProto = normalizeProtocol(existing.protocol || '');
							const samePort = existing.ip === newSvc.ip && existing.port === newSvc.port;
							if (samePort && exProto) {
								conflict = true;
								break;
							}
						}
						if (conflict) break;
					}
					if (conflict) break;
				}

                if (invalid) {
                    console.warn(`Service registration rejected (invalid fields) for ${senderId}`);
                    return;
                }

				if (conflict) {
					console.warn(`Service conflict detected for ${senderId}`);
					return;
				}

				this.services.set(senderId, newServices);
				this.broadcastServiceUpdate();
				return;
			}

			// Intercept JOIN message to update metadata
			if (msg.type === 'join') {
                console.log(`[JOIN] Received join request from ${msg.id} (Name: ${msg.name}, IP: ${msg.ip})`);
				// 0. Check for existing session with same ID and close it (Kick old session)
				for (const [ws, existingMeta] of this.sessions) {
					if (ws !== sender && existingMeta.id === msg.id) {
						console.log(`[JOIN] Kicking duplicate session for ID: ${msg.id}`);
						// Mark as replaced so close handler doesn't broadcast peer_left
						existingMeta.replaced = true;
                        this.sessions.delete(ws); // Immediately remove from map to prevent race conditions
						try {
							// ws.close(1000, "Duplicate Login");
                            // Just close without code to avoid potential protocol errors if socket is weird
                            ws.close();
						} catch (e) {
							// Ignore if already closed
						}
						// We don't delete here, let the close handler do it (but we deleted above)
                        // Close handler will check map, find nothing, and just log session count (safe)
					}
				}

				const existingSession = this.sessions.get(sender);
				const meta = { 
                    id: this.clamp(msg.id), 
                    ip: this.clamp(msg.ip, 32), 
                    public_addr: existingSession?.public_addr || 'unknown',
                    p2p_port: Number(msg.p2p_port) || 0,
                    name: this.clamp(msg.name),
                    os: this.clamp(msg.os),
                    version: this.clamp(msg.version),
                    device_type: this.clamp(msg.device_type, 32),
                    is_gateway: !!msg.is_gateway,
                    connected_at: Date.now()
                };
                if (meta.ip) {
                    // Use a function that doesn't rely on captured scope for pruneLeases if possible, 
                    // but here it's defined in fetch() so it's fine.
                    const now = Date.now();
                    for (const [ip, lease] of this.ipLeases) {
                        if (now - lease.ts > 10 * 60 * 1000) {
                            this.ipLeases.delete(ip);
                        }
                    }
                    this.ipLeases.set(meta.ip, { id: meta.id, ts: Date.now() });
                }
				this.sessions.set(sender, meta);
				console.log(`[JOIN] Session stored. Total active sessions: ${this.sessions.size}`);

				// 1. Send existing peers to the new joiner
                let sentCount = 0;
				for (const [ws, otherMeta] of this.sessions) {
                    if (ws !== sender && otherMeta.id) {
                        console.log(`[JOIN] Notifying joiner ${meta.id} about existing peer ${otherMeta.id}`);
                        this.safeSend(sender, JSON.stringify({
							type: 'peer_joined',
							...otherMeta
						}));
                        sentCount++;
					}
				}
                console.log(`[JOIN] Sent ${sentCount} existing peers to ${meta.id}`);


				// 1.5 Send existing services to new joiner
				// We can just trigger a broadcast update to everyone including self, simplest way
				this.broadcastServiceUpdate();

				// 2. Broadcast this new peer to others (as peer_joined)
                console.log(`[JOIN] Broadcasting new peer ${meta.id} to others`);
				this.broadcast({
					type: 'peer_joined',
					...meta
				}, sender);
				
				return;
			}

			// Forward other messages
            const targetId = msg.target_id || msg.target; // Support both fields
			if (targetId) {
				// Find target socket
                let found = false;
				for (const [ws, meta] of this.sessions) {
					if (meta.id === targetId) {
                        this.safeSend(ws, data);
                        found = true;
						break;
					}
				}
                if (!found) {
                    console.warn(`[FORWARD] Target ${targetId} not found for message type: ${msg.type}`);
                }
			} else {
				// Broadcast
				this.broadcast(msg, sender);
			}
		} catch (e) {
			console.error('Error handling message:', e);
		}
	}

	broadcastServiceUpdate() {
		const payload = [];
		for (const [pid, svcs] of this.services) {
			for (const s of svcs) {
				payload.push([pid, s]);
			}
		}
		
		this.broadcast({
			type: 'service_update',
			services: payload
		});
	}

	safeSend(ws: WebSocket, data: string) {
		if (ws.readyState === WebSocket.READY_STATE_OPEN) {
			try {
				ws.send(data);
			} catch (e) {
				// Ignore
			}
		}
	}

	broadcast(msg: any, exclude?: WebSocket) {
		const data = JSON.stringify(msg);
		for (const [ws, _] of this.sessions) {
			if (ws !== exclude) {
				this.safeSend(ws, data);
			}
		}
	}
}

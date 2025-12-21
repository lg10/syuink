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
					"Access-Control-Allow-Headers": "Content-Type",
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
				if (!token) return new Response('Unauthorized: Token required', { status: 401 });
				
				// Validate user
				const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token).first();
				if (!user) return new Response('Unauthorized: Invalid Token', { status: 401 });
				
				groupId = user.id as string;
                console.log(`[WS] Resolved GroupID: ${groupId} from Token: ${token}`);
			} else {
				// API Access
				// In real app, we should validate Authorization header here
				const parts = url.pathname.split('/');
				if (parts[2] === 'group' && parts[4] === 'devices') {
					groupId = parts[3];
                    console.log(`[API] Resolved GroupID: ${groupId} from URL`);
				} else {
					return new Response('Not Found', { status: 404 });
				}
			}

			// Forward to DO
			const id = env.SIGNAL_ROOM.idFromName(groupId);
            console.log(`[DO] Accessing Room ID: ${id.toString()}`);
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
        name?: string, 
        os?: string, 
        version?: string, 
        device_type?: string, 
        is_gateway?: boolean,
        connected_at?: number,
        replaced?: boolean 
    }>;
	services: Map<string, any[]>; // PeerID -> List of ServiceDecl

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.sessions = new Map();
		this.services = new Map();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Handle API request to list devices
		if (url.pathname.endsWith('/devices')) {
            console.log(`[API] Listing devices. Total sessions: ${this.sessions.size}`);
			const devices = [];
			for (const [_, meta] of this.sessions) {
                console.log(`[API] Session Check: ID=${meta.id}, Name=${meta.name}, IP=${meta.ip}`);
				if (meta.id) {
					devices.push(meta);
				}
			}
            console.log(`[API] Returning ${devices.length} devices`);
			return new Response(JSON.stringify(devices), {
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
			});
		}

		// Handle WebSocket Upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();
		this.sessions.set(server, {}); // Empty metadata initially
		console.log('New WebSocket connection established. Total sessions:', this.sessions.size);

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

				// Simple Conflict Detection (First Come First Serve)
				// Except printers/discovery
				let conflict = false;
				for (const newSvc of newServices) {
					if (newSvc.service_type === 'printer' || newSvc.service_type === 'discovery') continue;

					for (const [pid, svcs] of this.services) {
						if (pid === senderId) continue;
						for (const existing of svcs) {
							if (existing.ip === newSvc.ip && 
								existing.port === newSvc.port && 
								existing.protocol === newSvc.protocol) {
								conflict = true;
								break;
							}
						}
						if (conflict) break;
					}
					if (conflict) break;
				}

				if (conflict) {
					// Send error (Optional)
					console.warn(`Service conflict detected for ${senderId}`);
					return;
				}

				this.services.set(senderId, newServices);
				this.broadcastServiceUpdate();
				return;
			}

			// Intercept JOIN message to update metadata
			if (msg.type === 'join') {
				// 0. Check for existing session with same ID and close it (Kick old session)
				for (const [ws, existingMeta] of this.sessions) {
					if (ws !== sender && existingMeta.id === msg.id) {
						console.log(`Closing duplicate session for ${msg.id}`);
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

				const meta = { 
                    id: msg.id, 
                    ip: msg.ip, 
                    name: msg.name,
                    os: msg.os,
                    version: msg.version,
                    device_type: msg.device_type,
                    is_gateway: msg.is_gateway,
                    connected_at: Date.now()
                };
				this.sessions.set(sender, meta);
				console.log(`Peer Joined: ${meta.name} (${meta.ip}) - OS: ${meta.os}`);

				// 1. Send existing peers to the new joiner
                console.log(`[JOIN] Sending existing peers to new client ${msg.id}`);
                let sentCount = 0;
				for (const [ws, otherMeta] of this.sessions) {
                    const isSelf = ws === sender;
                    console.log(`[JOIN] Checking peer ${otherMeta.id} (IsSelf: ${isSelf})`);
					if (!isSelf && otherMeta.id) {
                        console.log(`[JOIN] Sending peer ${otherMeta.id} to new client`);
                        this.safeSend(sender, JSON.stringify({
							type: 'peer_joined',
							...otherMeta
						}));
                        sentCount++;
					}
				}
                console.log(`[JOIN] Sent ${sentCount} existing peers`);

				// 1.5 Send existing services to new joiner
				// We can just trigger a broadcast update to everyone including self, simplest way
				this.broadcastServiceUpdate();

				// 2. Broadcast this new peer to others (as peer_joined)
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
				for (const [ws, meta] of this.sessions) {
					if (meta.id === targetId) {
                        this.safeSend(ws, data);
						break;
					}
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

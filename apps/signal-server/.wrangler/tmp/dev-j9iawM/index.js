var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-R7RQdC/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// .wrangler/tmp/bundle-R7RQdC/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/index.ts
var INIT_USERS_SQL = "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);";
var INIT_DEVICES_SQL = "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));";
var src_default = {
  async fetch(request, env, ctx) {
    try {
      await env.DB.exec(INIT_USERS_SQL);
      await env.DB.exec(INIT_DEVICES_SQL);
    } catch (e) {
      console.error("DB Init Error (Non-fatal if tables exist):", e);
    }
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    if (url.pathname === "/api/register" && request.method === "POST") {
      return await handleRegister(request, env);
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      return await handleLogin(request, env);
    }
    if (url.pathname.startsWith("/wapi/") || url.pathname.startsWith("/api/group/")) {
      let groupId = "";
      if (url.pathname.startsWith("/wapi/")) {
        const token = url.searchParams.get("token");
        if (!token) {
          console.error("[WS] Connection rejected: Missing token");
          return new Response("Unauthorized: Token required", { status: 401 });
        }
        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token).first();
        if (!user) {
          console.error(`[WS] Connection rejected: Invalid token ${token}`);
          return new Response("Unauthorized: Invalid Token", { status: 401 });
        }
        groupId = user.id;
        console.log(`[WS] Resolved GroupID: ${groupId} from Token: ${token}`);
      } else {
        const parts = url.pathname.split("/");
        if (parts[2] === "group") {
          groupId = parts[3];
          console.log(`[API] Resolved GroupID: ${groupId} from /api/group/ URL: ${url.pathname}`);
        } else {
          console.warn(`[API] Path not recognized: ${url.pathname}`);
          return new Response("Not Found", { status: 404 });
        }
      }
      if (!groupId) {
        console.error(`[DO] Could not resolve groupId for path: ${url.pathname}`);
        return new Response("Group not found", { status: 404 });
      }
      const id = env.SIGNAL_ROOM.idFromName(groupId);
      console.log(`[DO] Forwarding ${request.method} ${url.pathname} to Room ID: ${id.toString()} (Group: ${groupId})`);
      const obj = env.SIGNAL_ROOM.get(id);
      return obj.fetch(request);
    }
    return new Response("Syuink Signaling Server Running", {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
};
async function handleRegister(request, env) {
  try {
    const { email, password } = await request.json();
    if (!email || !password)
      return new Response("Missing fields", { status: 400 });
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
    ).bind(id, email, password, Date.now()).run();
    return new Response(JSON.stringify({ id, email }), {
      status: 201,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
__name(handleRegister, "handleRegister");
async function handleLogin(request, env) {
  try {
    const { email, password } = await request.json();
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
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
__name(handleLogin, "handleLogin");
var SignalRoom = class {
  state;
  // Store metadata with the socket
  sessions;
  services;
  // PeerID -> List of ServiceDecl
  ipLeases;
  // ip -> lease info
  clamp(val, maxLen = 128) {
    if (typeof val !== "string")
      return "";
    return val.slice(0, maxLen);
  }
  constructor(state, env) {
    this.state = state;
    this.sessions = /* @__PURE__ */ new Map();
    this.services = /* @__PURE__ */ new Map();
    this.ipLeases = /* @__PURE__ */ new Map();
  }
  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const leaseTtlMs = 10 * 60 * 1e3;
    const parts = url.pathname.split("/");
    let groupIdFromPath = "";
    if (url.pathname.includes("/api/group/")) {
      groupIdFromPath = parts[3] || "";
    } else if (url.pathname.startsWith("/wapi/")) {
      groupIdFromPath = parts[2] || "";
    }
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const isWsUpgrade = request.headers.get("Upgrade") === "websocket";
    const authorized = isWsUpgrade || !!groupIdFromPath && token === groupIdFromPath;
    if (!isWsUpgrade) {
      console.log(`[DO Auth] Path: ${url.pathname}, Group: ${groupIdFromPath}, Token: ${token ? "present" : "missing"}, Authorized: ${authorized}`);
    }
    const pruneLeases = /* @__PURE__ */ __name(() => {
      const now = Date.now();
      let count = 0;
      for (const [ip, lease] of this.ipLeases) {
        if (now - lease.ts > leaseTtlMs) {
          this.ipLeases.delete(ip);
          count++;
        }
      }
      if (count > 0)
        console.log(`[DO Lease] Pruned ${count} expired leases`);
    }, "pruneLeases");
    if (url.pathname.endsWith("/devices")) {
      if (!authorized) {
        console.warn(`[API] Unauthorized /devices. Expected Bearer ${groupIdFromPath}, got ${authHeader}`);
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const devices = [];
      for (const [_, meta] of this.sessions) {
        if (meta.id)
          devices.push(meta);
      }
      return new Response(JSON.stringify(devices), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (url.pathname.endsWith("/allocate_ip")) {
      if (!authorized) {
        console.warn(`[API] Unauthorized /allocate_ip. Expected Bearer ${groupIdFromPath}, got ${authHeader}`);
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      pruneLeases();
      const usedIps = /* @__PURE__ */ new Set();
      for (const [_, meta] of this.sessions) {
        if (meta.ip)
          usedIps.add(meta.ip);
      }
      for (const [ip, lease] of this.ipLeases) {
        usedIps.add(ip);
      }
      let allocated = "";
      for (let i = 2; i < 255; i++) {
        const candidate = `10.10.0.${i}`;
        if (!usedIps.has(candidate)) {
          allocated = candidate;
          this.ipLeases.set(candidate, { id: `lease:${groupIdFromPath}`, ts: Date.now() });
          break;
        }
      }
      console.log(`[API] Allocated IP: ${allocated} for group: ${groupIdFromPath}`);
      if (!allocated)
        return new Response("No available IPs", { status: 507, headers: corsHeaders });
      return new Response(JSON.stringify({ ip: allocated }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const xForwardedFor = request.headers.get("X-Forwarded-For")?.split(",")[0].trim();
    const xRealIp = request.headers.get("X-Real-IP");
    const cfIp = request.headers.get("CF-Connecting-IP");
    let publicAddr = "unknown";
    if (xForwardedFor && !xForwardedFor.startsWith("172.") && !xForwardedFor.startsWith("10.") && !xForwardedFor.startsWith("192.168.")) {
      publicAddr = xForwardedFor;
    } else if (xRealIp && !xRealIp.startsWith("172.") && !xRealIp.startsWith("10.") && !xRealIp.startsWith("192.168.")) {
      publicAddr = xRealIp;
    } else {
      publicAddr = xForwardedFor || xRealIp || cfIp || "unknown";
    }
    server.accept();
    this.sessions.set(server, { public_addr: publicAddr });
    console.log(`New WebSocket connection from ${publicAddr}. (Raw CF: ${cfIp}, XFF: ${xForwardedFor}). Total sessions:`, this.sessions.size);
    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data);
    });
    server.addEventListener("close", () => {
      try {
        const meta = this.sessions.get(server);
        if (meta && meta.id && !meta.replaced) {
          this.broadcast({
            type: "peer_left",
            id: meta.id
          }, server);
          if (this.services.has(meta.id)) {
            this.services.delete(meta.id);
            this.broadcastServiceUpdate();
          }
        }
        if (meta && meta.ip && this.ipLeases.has(meta.ip)) {
          this.ipLeases.delete(meta.ip);
        }
        this.sessions.delete(server);
        console.log("WebSocket connection closed. Total sessions:", this.sessions.size);
      } catch (e) {
        console.error("Error in close handler:", e);
      }
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  handleMessage(sender, data) {
    try {
      const msgStr = data;
      const msg = JSON.parse(msgStr);
      if (msg.type === "register_services") {
        const senderId = msg.id;
        const newServices = msg.services;
        const ipRegex = /^\d{1,3}(?:\.\d{1,3}){3}$/;
        const normalizeProtocol = /* @__PURE__ */ __name((p) => {
          if (!p)
            return "";
          const val = p.toLowerCase();
          if (val === "tcp" || val === "udp" || val === "both")
            return val;
          return "";
        }, "normalizeProtocol");
        let conflict = false;
        let invalid = false;
        for (const newSvc of newServices) {
          if (!newSvc || !newSvc.ip || !ipRegex.test(newSvc.ip)) {
            invalid = true;
            break;
          }
          if (!newSvc.port || newSvc.port < 1 || newSvc.port > 65535) {
            invalid = true;
            break;
          }
          const proto = normalizeProtocol(newSvc.protocol);
          if (!proto) {
            invalid = true;
            break;
          }
          newSvc.protocol = proto;
          for (const [pid, svcs] of this.services) {
            if (pid === senderId)
              continue;
            for (const existing of svcs) {
              const exProto = normalizeProtocol(existing.protocol || "");
              const samePort = existing.ip === newSvc.ip && existing.port === newSvc.port;
              if (samePort && exProto) {
                conflict = true;
                break;
              }
            }
            if (conflict)
              break;
          }
          if (conflict)
            break;
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
      if (msg.type === "join") {
        console.log(`[JOIN] Received join request from ${msg.id} (Name: ${msg.name}, IP: ${msg.ip})`);
        for (const [ws, existingMeta] of this.sessions) {
          if (ws !== sender && existingMeta.id === msg.id) {
            console.log(`[JOIN] Kicking duplicate session for ID: ${msg.id}`);
            existingMeta.replaced = true;
            this.sessions.delete(ws);
            try {
              ws.close();
            } catch (e) {
            }
          }
        }
        const existingSession = this.sessions.get(sender);
        const meta = {
          id: this.clamp(msg.id),
          ip: this.clamp(msg.ip, 32),
          public_addr: existingSession?.public_addr || "unknown",
          p2p_port: Number(msg.p2p_port) || 0,
          name: this.clamp(msg.name),
          os: this.clamp(msg.os),
          version: this.clamp(msg.version),
          device_type: this.clamp(msg.device_type, 32),
          is_gateway: !!msg.is_gateway,
          connected_at: Date.now()
        };
        if (meta.ip) {
          const now = Date.now();
          for (const [ip, lease] of this.ipLeases) {
            if (now - lease.ts > 10 * 60 * 1e3) {
              this.ipLeases.delete(ip);
            }
          }
          this.ipLeases.set(meta.ip, { id: meta.id, ts: Date.now() });
        }
        this.sessions.set(sender, meta);
        console.log(`[JOIN] Session stored. Total active sessions: ${this.sessions.size}`);
        let sentCount = 0;
        for (const [ws, otherMeta] of this.sessions) {
          if (ws !== sender && otherMeta.id) {
            console.log(`[JOIN] Notifying joiner ${meta.id} about existing peer ${otherMeta.id}`);
            this.safeSend(sender, JSON.stringify({
              type: "peer_joined",
              ...otherMeta
            }));
            sentCount++;
          }
        }
        console.log(`[JOIN] Sent ${sentCount} existing peers to ${meta.id}`);
        this.broadcastServiceUpdate();
        console.log(`[JOIN] Broadcasting new peer ${meta.id} to others`);
        this.broadcast({
          type: "peer_joined",
          ...meta
        }, sender);
        return;
      }
      const targetId = msg.target_id || msg.target;
      if (targetId) {
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
        this.broadcast(msg, sender);
      }
    } catch (e) {
      console.error("Error handling message:", e);
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
      type: "service_update",
      services: payload
    });
  }
  safeSend(ws, data) {
    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(data);
      } catch (e) {
      }
    }
  }
  broadcast(msg, exclude) {
    const data = JSON.stringify(msg);
    for (const [ws, _] of this.sessions) {
      if (ws !== exclude) {
        this.safeSend(ws, data);
      }
    }
  }
};
__name(SignalRoom, "SignalRoom");

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-R7RQdC/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-R7RQdC/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  SignalRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

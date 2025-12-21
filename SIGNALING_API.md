# Syuink 信令服务器 API 文档

本文档描述了 Syuink 信令服务器提供的 HTTP 接口和 WebSocket 通信协议。

## 基础信息

- **默认端口**: `8787`
- **协议**: HTTP / WebSocket
- **Base URL**: `http://<server-ip>:8787` (HTTP) / `ws://<server-ip>:8787` (WebSocket)

---

## 1. HTTP 接口

### 1.1 用户注册

注册一个新的账号。

- **URL**: `/api/register`
- **Method**: `POST`
- **Content-Type**: `application/json`

**请求参数**:

```json
{
  "email": "user@example.com",
  "password": "your_password"
}
```

**响应 (201 Created)**:

```json
{
  "id": "uuid-string",
  "email": "user@example.com"
}
```

---

### 1.2 用户登录

验证用户凭据并获取访问令牌（Token）。目前的实现中，Token 即为用户的 UUID。

- **URL**: `/api/login`
- **Method**: `POST`
- **Content-Type**: `application/json`

**请求参数**:

```json
{
  "email": "user@example.com",
  "password": "your_password"
}
```

**响应 (200 OK)**:

```json
{
  "token": "user-uuid-token",
  "email": "user@example.com"
}
```

---

### 1.3 获取组内设备列表

获取指定组（用户）当前在线的所有设备信息。此接口常用于客户端主动拉取最新设备列表。

- **URL**: `/api/group/:groupId/devices`
  - `:groupId` 通常为用户的 `token` (即 User ID)。
- **Method**: `GET`

**响应 (200 OK)**:

```json
[
  {
    "id": "device-uuid",
    "ip": "10.10.0.2",
    "name": "My Windows PC"
  },
  {
    "id": "device-uuid-2",
    "ip": "10.10.0.3",
    "name": "MacBook Pro"
  }
]
```

---

## 2. WebSocket 接口

WebSocket 用于设备间的实时信令交换（如握手、P2P 协商）以及设备上下线通知。

### 2.1 建立连接

- **URL**: `/wapi/`
- **Query Param**: `token=<user-token>` (必须)

**示例**: `ws://localhost:8787/wapi/?token=user-uuid-token`

> **注意**: 连接成功后，服务器会验证 Token。如果 Token 无效，连接将被拒绝 (401)。连接成功建立意味着设备已进入该用户的专属“房间”。

---

### 2.2 信令消息格式

所有 WebSocket 消息均为 JSON 格式，包含一个 `type` 字段。

#### A. 客户端发送的消息

**1. 加入网络 (Join)**
连接建立后，客户端应立即发送此消息以声明自己的身份。

```json
{
  "type": "join",
  "id": "device-uuid",
  "ip": "10.10.0.x",     // 虚拟 IP
  "name": "Device Name"
}
```

**2. P2P 协商 (Offer / Answer / Candidate)**
用于 WebRTC/QUIC 建立连接的 SDP 信息交换。

```json
{
  "type": "offer",       // 或 "answer", "candidate"
  "target_id": "target-device-uuid",
  "sdp": "...",          // 具体的协商数据
  "candidate": "..."     // 如果是 candidate 类型
}
```

#### B. 服务器推送的消息

**1. 设备加入通知 (Peer Joined)**
当有新设备加入，或当前设备刚加入时收到房间内已有设备的信息。

```json
{
  "type": "peer_joined",
  "id": "device-uuid",
  "ip": "10.10.0.x",
  "name": "Device Name"
}
```

**2. 设备离线通知 (Peer Left)**
当组内某个设备断开连接时收到。

```json
{
  "type": "peer_left",
  "id": "device-uuid"
}
```

**3. 转发的消息**
服务器会将带有 `target_id` 的消息原样转发给目标设备。

---

## 3. 部署说明

使用 Docker 部署时，请确保映射 `8787` 端口，并挂载数据卷以持久化数据库。

```bash
docker run -d -p 8787:8787 -v syuink_data:/app/apps/signal-server/.wrangler syuink-signal:latest
```

如果是 Nginx 反向代理，请配置 `/wapi/` 路径支持 WebSocket Upgrade 头。

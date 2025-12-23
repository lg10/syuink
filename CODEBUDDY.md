# CODEBUDDY.md This file provides guidance to CodeBuddy Code when working with code in this repository.

## 🛠 开发常用命令 (Common Development Commands)

### 前端与桌面端 (Frontend & Desktop)
- **安装依赖**: `npm install`
- **启动开发环境**: `npm run dev` (同时启动前端和 Tauri 后端)
- **构建 Windows 执行文件**: `npm run desktop:exe`
- **构建 Windows 安装包**: `npm run package:win64`
- **构建 macOS 应用**: `npm run tauri build --workspace=syuink-desktop` (产物在 `src-tauri/target/release/bundle/dmg`)
- **启动信令服务器**: `npm run signal`

### Rust 核心 (Rust Core)
- **编译全量项目**: `cargo build --workspace`
- **运行全量测试**: `cargo test --workspace`
- **代码检查**: `cargo clippy --workspace`
- **运行单个测试**: `cargo test -p <crate_name> --lib <test_name>` (例如 `cargo test -p p2p-node --lib test_handshake`)

## 🏗 高层架构 (High-Level Architecture)

本项目是一个基于 Rust 和 Tauri v2 构建的 P2P Mesh VPN。采用 Monorepo 结构，主要分为应用层 (`apps/`) 和核心逻辑层 (`crates/`)。

### 核心组件
- **apps/desktop**: 桌面端主程序。
  - **Frontend**: React + TypeScript + TailwindCSS。
  - **Backend**: Tauri v2。入口位于 `apps/desktop/src-tauri/src/main.rs`，负责管理 `VpnState` 并通过 Tauri Commands 与前端通信（如 `start_vpn`, `stop_vpn`）。
- **apps/signal-server**: 基于 Node.js/TypeScript 的信令服务器。用于节点发现、握手和作为 P2P 无法直连时的中继。
- **crates/p2p-node**: **核心网络库**。
  - `lib.rs`: 定义了 `P2PNode` 及其主事件循环。管理 TUN 设备、信令连接、SOCKS5 服务和路由。
  - `signaling.rs`: 处理与信令服务器的 WebSocket 通信。
  - `socks5.rs`: 内置 SOCKS5 代理服务器，用于处理 TCP 流量转发。
  - `gateway.rs`: 处理 NAT 和网关转发逻辑。
- **crates/tun-device**: 跨平台 TUN 设备抽象层，处理虚拟网卡的创建和读写。

### 网络流转逻辑 (Networking Flow)
1. **启动阶段**: `P2PNode` 创建 TUN 网卡，分配虚拟 IP。
2. **连接阶段**: 连接信令服务器并加入指定 Group。
3. **发现阶段**: 接收 `PeerJoined` 消息，建立对端路由表。
4. **出站流量 (Outbound)**:
   - 从 TUN 读取数据包。
   - 广播/多播包（如 mDNS）通过 `BroadcastReflector` 转发至所有 Peer。
   - 单播包根据路由表封装后通过信令通道或 P2P 通道发送。
5. **入站流量 (Inbound)**:
   - 从信令/P2P 通道接收数据。
   - 解析后写入本地 TUN 网卡。
6. **代理流量**: TCP 流量优先建议通过内置 SOCKS5 代理处理，以提高稳定性。

## ⚠️ 开发注意事项 (Development Notes)
- **权限 (Critical)**: 
  - **Windows**: 必须使用 **管理员权限** 运行，否则无法创建 TUN 设备。
  - **macOS**: 创建 TUN 设备通常需要 root 权限。开发时若 `npm run dev` 启动的 VPN 无法连接，可能需要手动授权或使用 `sudo` 运行生成的二进制文件。
- **依赖**: 
  - **Windows**: 构建依赖 `wintun.dll`（位于 `apps/desktop/src-tauri/wintun.dll`）。
  - **macOS**: 需要安装 Xcode Command Line Tools (`xcode-select --install`)。
- **平台支持**: 目前 Windows 支持最完善。macOS 的系统代理设置已通过 `networksetup` 命令适配。

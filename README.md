# Syuink - P2P Mesh VPN & Remote Control

Syuink 是一款基于 Rust 和 Tauri 构建的现代化异地组网（Mesh VPN）与远程控制解决方案。

**[📖 中文使用手册与技术文档 (User Manual)](MANUAL_ZH.md)**

## 特性 (Features)

*   **P2P Mesh 组网**: 使用 QUIC/WebRTC 协议直连，低延迟。
*   **分布式服务网格**: 去中心化架构，任意设备均可声明并共享局域网服务 (IP/Port)。
*   **虚拟局域网**: 将异地设备连接在同一虚拟网段。
*   **服务发现与 UDP 穿透**: 支持 mDNS (Bonjour)、SSDP、UDP 游戏联机、打印机共享。
*   **TCP 直连 (SOCKS5)**: 内置 SOCKS5 代理，支持 SSH、HTTP 等 TCP 服务的隧道传输。
*   **跨平台**: Windows, macOS, Linux (移动端计划中)。

## 开发环境 (Prerequisites)

### Windows
1.  **Rust**: [rustup.rs](https://rustup.rs/)
2.  **Node.js**: [nodejs.org](https://nodejs.org/)
3.  **C++ Build Tools**: Visual Studio Installer -> "Desktop development with C++"
4.  **Wintun**: 需要 `wintun.dll` (通常自动处理)。

### macOS / Linux
1.  **Rust** & **Node.js**
2.  **依赖**:
    *   Linux: `sudo apt install libwebkit2gtk-4.0-dev build-essential curl wget libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`

## 项目结构 (Project Structure)

*   `apps/desktop`: 主程序 (Tauri GUI + Frontend)。
*   `apps/cli`: 命令行版本 (适用于无头服务器)。
*   `apps/signal-server`: 信令服务器 (Cloudflare Workers / Node.js)。
*   `crates/p2p-node`: 核心网络库 (TUN, NAT, SOCKS5, Signaling)。
*   `crates/tun-device`: 虚拟网卡封装。

## 运行指南 (How to Run)

### 运行桌面端 (GUI)

```bash
cd apps/desktop
npm install
npm run tauri dev
```

### 运行 CLI (Headless)

```bash
cargo run -p syuink-cli -- --ip 10.10.0.2 --mask 255.255.255.0
```

> **注意**: 必须以 **管理员 (Administrator)** 或 `sudo` 权限运行以创建虚拟网卡。

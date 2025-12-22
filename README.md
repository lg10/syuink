# Syuink - 下一代 P2P Mesh VPN 与远程互联工具

![Syuink Banner](https://img.shields.io/badge/Status-Beta-blue?style=for-the-badge) ![Rust](https://img.shields.io/badge/Rust-Enabled-orange?style=for-the-badge&logo=rust) ![Tauri](https://img.shields.io/badge/Tauri-v2-blueviolet?style=for-the-badge&logo=tauri) ![React](https://img.shields.io/badge/React-Framework-61DAFB?style=for-the-badge&logo=react) ![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**Syuink** 是一款基于 **Rust** 和 **Tauri v2** 构建的现代化、高性能异地组网（Mesh VPN）解决方案。

它旨在通过 P2P 直连技术，将分布在世界各地的设备连接到同一个虚拟局域网中，实现安全、低延迟的互联互通。无论是远程办公、家庭 NAS 访问、还是跨地域游戏联机，Syuink 都能提供“像在局域网一样”的体验。

[📖 查看详细中文手册 (User Manual)](MANUAL_ZH.md) | [🔌 信令服务器 API 文档](SIGNALING_API.md) | [☁️ 服务器部署指南](SERVER_DEPLOY.md)

---

## ✨ 核心特性 (Features)

*   **🚀 极致性能**: 基于 Rust 编写的核心网络栈，内存占用极低，吞吐量极高。
*   **🕸️ P2P Mesh 组网**: 优先尝试 UDP P2P 直连（NAT 穿透），无法直连时自动回退中继，确保连接通畅。
*   **🛡️ 安全隐私**: 全链路加密传输，去中心化设计，您的数据只属于您自己。
*   **🖥️ 轻量级 GUI**: 基于 Tauri v2 + React 构建的现代化界面，Windows 安装包仅数 MB。
*   **🔌 多模式代理**:
    *   **TUN 模式**: 全局虚拟网卡，支持 UDP/ICMP 协议透明传输（如游戏联机、打印机发现）。
    *   **SOCKS5 模式**: 内置代理服务器，支持 TCP 协议（如 SSH、Web、NAS），可配合系统代理使用。
*   **🌍 跨平台支持**: 
    *   **Windows**: 完美支持 (Win10/Win11, x64/x86)。
    *   **macOS / Linux**: 核心功能兼容 (正在完善 GUI 适配)。
    *   **Headless CLI**: 适用于服务器和无头设备的命令行版本。

## 🛠️ 技术栈 (Tech Stack)

*   **Frontend**: React, TypeScript, TailwindCSS, Vite
*   **Backend (Desktop)**: Tauri v2, Rust
*   **Core Networking**: 
    *   `tokio` (异步运行时)
    *   `quinn` (QUIC 协议)
    *   `tun` (虚拟设备驱动)
    *   `smoltcp` (用户态 TCP/IP 栈)

## 🚀 快速开始 (Getting Started)

### 前置要求 (Prerequisites)

1.  **Rust**: [安装 Rust](https://rustup.rs/)
2.  **Node.js**: (推荐 v18+, 使用 pnpm 或 npm)
3.  **构建工具**:
    *   **Windows**: 安装 Visual Studio C++ 生成工具 (Desktop development with C++)。
    *   **macOS**: `xcode-select --install`
    *   **Linux**: `sudo apt install build-essential libwebkit2gtk-4.0-dev ...`

### 开发运行 (Development)

```bash
# 1. 克隆项目
git clone https://github.com/lg10/syuink.git
cd syuink

# 2. 安装依赖
npm install

# 3. 启动开发环境 (同时启动前端和 Rust 后端)
# 注意：Windows 上会自动请求管理员权限，请在弹出的 UAC 窗口中点击“是”
npm run dev
```

### 生产构建 (Build)

构建独立的安装包或可执行文件：

```bash
# 构建 Windows 64位 安装包
npm run package:win64

# 仅构建 Windows 可执行文件 (无安装包)
npm run desktop:exe
```

> **⚠️ Windows 构建注意事项**: 
> 1. 构建生成的 `.exe` 文件位于 `target/release/syuink-desktop.exe`。
> 2. 运行该程序必须确保同目录下存在 `wintun.dll` 文件（可从 `apps/desktop/src-tauri/wintun.dll` 复制）。
> 3. 程序必须以 **管理员身份 (Run as Administrator)** 运行才能创建虚拟网卡。

## 📂 项目结构 (Project Structure)

本项目采用 Monorepo 结构：

*   `apps/`
    *   `desktop/`: 桌面端主程序 (Tauri + React)。
    *   `cli/`: 纯命令行版本，适用于服务器部署。
    *   `signal-server/`: 信令服务器 (用于节点发现和握手)。
*   `crates/`
    *   `p2p-node/`: **核心库**。包含 P2P 握手、NAT 穿透、加密通信、虚拟网络栈逻辑。
    *   `tun-device/`: 跨平台 TUN 设备抽象层。

## 🤝 贡献 (Contributing)

欢迎提交 Issue 和 Pull Request！

1.  Fork 本仓库。
2.  创建您的特性分支 (`git checkout -b feature/AmazingFeature`)。
3.  提交您的更改 (`git commit -m 'Add some AmazingFeature'`)。
4.  推送到分支 (`git push origin feature/AmazingFeature`)。
5.  开启一个 Pull Request。

## 📄 许可证 (License)

本项目基于 **MIT License** 开源。详情请参阅 [LICENSE](LICENSE) 文件。

---

**Syuink** - Connect Freely, Securely, Everywhere.

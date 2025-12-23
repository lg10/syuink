# 修改历史 (Changelog)

## 2025-12-23

### 桌面端 (Desktop)
- **后端 (Rust/Tauri)**:
    - 新增 `get_system_info` 命令，用于获取本机的操作系统名称、版本号和主机名。
    - 定义了 `SystemInfo` 结构体并在 `main.rs` 中注册了该命令。
- **macOS 适配**:
    - 实现了 macOS 下的权限自动提升逻辑（若非 root 运行则尝试通过 `sudo` 重新启动）。
    - 优化了 macOS 的主机名获取方式，优先使用 `scutil --get ComputerName` 获取用户友好名称。
    - 完善了 macOS 下的系统代理设置功能，使用 `networksetup` 配置 SOCKS5 代理。
- **图标与资源**:
    - 更新了应用全尺寸图标（包括 128x128, 64x64, 32x32 等）。
    - 更新了托盘图标（未连接状态 `icon.png` 与已连接状态 `icon_connected.png`）。
    - 更新了各平台通用的资源文件及商店图标。

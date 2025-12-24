# 修改历史 (Changelog)

## 2025-12-24

- **网络与并发优化**:
    - **信令服务器**: 新增 `/allocate_ip` 接口，并增加租约（10 分钟）与释放机制，校验 Bearer 鉴权，自动清理超时；对 `join` 元数据做长度截断；服务注册新增 IP/端口/协议校验，并对同 IP+端口（跨协议）冲突进行阻断。
    - **桌面端**: 优化了 VPN 启动流程，优先请求服务器分配 IP（携带 Bearer），若分配失败则回退至本地自动发现模式；增加后台健康轮询确保状态一致；全局代理设置失败时自动回滚开关。
    - **系统代理可靠性**: Windows/macOS 设置系统代理后增加读取校验，校验失败返回错误提示。


## 2025-12-23

- **后端 (Rust/Tauri)**:
    - 新增 `get_system_info` 命令，用于获取本机的操作系统名称、版本号和主机名。
    - 定义了 `SystemInfo` 结构体并在 `main.rs` 中注册了该命令。
- **前端 (React/Context)**:
    - 更新 `VPNContext.tsx`，在 context 中增加了 `deviceOs` 和 `deviceVersion` 状态，并自动同步系统信息。
    - 更新 `Devices.tsx` 页面，展示本机的真实系统版本。
    - 首页连接状态面板新增虚拟 IP 与 SOCKS5 代理地址 (`127.0.0.1:port`) 的直观显示。
- **项目管理**:
    - 更新 `.gitignore`，忽略 `Cargo.lock`、`package-lock.json` 以及 `.codebuddy/` 文件夹。
    - 更新 `MANUAL_ZH.md`，增加了详细的平台差异与功能实现对比表。
- **macOS 适配**:
    - 实现了 macOS 下的权限自动提升逻辑（若非 root 运行则尝试通过 `sudo` 重新启动）。
    - 优化了 macOS 的主机名获取方式，优先使用 `scutil --get ComputerName` 获取用户友好名称。
    - 完善了 macOS 下的系统代理设置功能，使用 `networksetup` 配置 SOCKS5 代理。
- **图标与资源**:
    - 更新了应用全尺寸图标（包括 128x128, 64x64, 32x32 等）。
    - 更新了托盘图标（未连接状态 `icon.png` 与已连接状态 `icon_connected.png`）。
    - 更新了各平台通用的资源文件及商店图标。

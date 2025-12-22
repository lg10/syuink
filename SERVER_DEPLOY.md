# Syuink 信令服务器部署指南 (Server Deployment Guide)

Syuink 依赖一个轻量级的信令服务器（Signal Server）来协调 P2P 节点的发现、握手（SDP 交换）和服务信息广播。虽然 Syuink 的核心流量是 P2P 直连的，但信令服务器是建立连接的必要“红娘”。

本文档提供三种部署方式：
1.  **Docker 部署 (推荐)**
2.  **直接编译部署 (Node.js)**
3.  **Linux 一键脚本**

---

## 1. Docker 部署 (推荐)

### 1.1 使用 Docker Compose (最简便)

在服务器上创建 `docker-compose.yml` 文件：

```yaml
version: '3'
services:
  signal-server:
    image: signal-server:latest
    container_name: syuink-signal
    restart: always
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
      # - LOG_LEVEL=info
```

启动服务：
```bash
docker-compose up -d
```

### 1.2 手动构建 Docker 镜像
如果您想自己构建镜像：

```bash
# 1. 克隆代码
git clone https://github.com/lg10/syuink.git
cd syuink/apps/signal-server

# 2. 构建镜像
docker build -t syuink-signal .

# 3. 运行容器
docker run -d \
  --name syuink-signal \
  -p 8787:8787 \
  --restart always \
  syuink-signal
```

### 1.3 Windows 环境快速构建 (导出镜像)
如果您在 Windows 开发机上安装了 **Docker Desktop**，可以使用项目根目录下的 `build_docker.ps1` 脚本一键构建并导出镜像文件，方便传输到服务器。

1.  **运行构建脚本**:
    ```powershell
    ./build_docker.ps1
    ```
2.  **获取镜像文件**:
    脚本执行成功后，会在根目录生成 `syuink-signal-x.x.x.tar` 文件。
3.  **上传并导入**:
    将该 `.tar` 文件上传到 Linux 服务器，然后执行：
    ```bash
    docker load -i syuink-signal-x.x.x.tar
    ```
4.  **启动**:
    导入后即可按上述步骤启动容器。

---

## 2. Linux 一键部署脚本

适用于 Ubuntu/Debian/CentOS 系统。该脚本会自动安装 Node.js 环境、拉取代码并使用 PM2 启动服务。

```bash
curl -fsSL https://raw.githubusercontent.com/lg10/syuink/main/scripts/install_server.sh | bash
```

*(注意：请将 URL 替换为您实际仓库的地址)*

---

## 3. 直接编译部署 (Node.js)

如果您不想使用 Docker，可以直接在服务器上运行 Node.js 程序。

### 前置要求
*   Node.js v18+
*   npm 或 pnpm

### 步骤

1.  **获取代码**:
    ```bash
    git clone https://github.com/lg10/syuink.git
    cd syuink/apps/signal-server
    ```

2.  **安装依赖**:
    ```bash
    npm install
    ```

3.  **编译**:
    ```bash
    npm run build
    ```

4.  **运行**:
    ```bash
    # 直接运行
    npm start
    
    # 或者指定端口
    PORT=9000 npm start
    ```

5.  **后台运行 (推荐使用 PM2)**:
    ```bash
    npm install -g pm2
    pm2 start dist/index.js --name "syuink-signal"
    pm2 save
    pm2 startup
    ```

---

## 4. 验证部署

部署完成后，可以通过浏览器访问或使用 `curl` 验证服务是否正常。

访问：`http://your-server-ip:8787/health`

如果返回 `{"status":"ok"}`，说明服务运行正常。

---

## 5. 客户端配置

在 Syuink 桌面端登录页面，点击右上角的 **设置 (Settings)** 图标，将 **信令服务器 (Signaling Server)** 地址修改为您部署的地址：

`ws://your-server-ip:8787`

*(如果配置了 Nginx 反向代理与 SSL，请使用 `wss://your-domain.com`)*

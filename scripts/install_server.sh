#!/bin/bash

# Syuink Signal Server Installer
# Supported OS: Ubuntu, Debian, CentOS

set -e

echo ">>> Syuink Signal Server Installer"

# 1. Install Node.js if not exists
if ! command -v node &> /dev/null; then
    echo ">>> Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs || sudo yum install -y nodejs
fi

# 2. Install PM2
if ! command -v pm2 &> /dev/null; then
    echo ">>> Installing PM2..."
    sudo npm install -g pm2
fi

# 3. Clone or Update Code
APP_DIR="/opt/syuink-signal"
REPO_URL="https://github.com/lg10/syuink.git" # REPLACE THIS

if [ -d "$APP_DIR" ]; then
    echo ">>> Updating existing installation..."
    cd "$APP_DIR"
    git pull
else
    echo ">>> Cloning repository..."
    sudo git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# 4. Install & Build
echo ">>> Building Signal Server..."
cd apps/signal-server
npm install
npm run build

# 5. Start Service
echo ">>> Starting Service..."
pm2 stop syuink-signal || true
pm2 delete syuink-signal || true
pm2 start dist/index.js --name "syuink-signal" --env PORT=8787

echo ">>> Installation Complete!"
echo ">>> Signal Server is running on port 8787"
echo ">>> Use 'pm2 logs syuink-signal' to view logs."

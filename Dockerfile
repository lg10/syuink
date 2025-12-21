# Use Node.js LTS
FROM node:20-slim

# Switch to Aliyun mirror for apt
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources || sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list

# Install basics
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json ./
COPY apps/signal-server/package.json ./apps/signal-server/package.json
# If you have other workspaces, you might need to copy them too, 
# but for now we focus on signal-server dependencies.

# Install dependencies
RUN npm config set registry https://registry.npmmirror.com
RUN npm install

# Copy source code
COPY . .

# Switch to signal server directory
WORKDIR /app/apps/signal-server

# Expose the Wrangler dev port
EXPOSE 8787

# Persist Wrangler data (D1 DB, Durable Objects)
VOLUME /app/apps/signal-server/.wrangler

# Start command
# Use --ip 0.0.0.0 to bind to all interfaces in Docker
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]

#!/bin/bash
set -e

echo "============================================"
echo "  星巴克卡券管理中心 - VPS 一键部署脚本"
echo "============================================"

APP_DIR="/opt/starbucks-coupon"
GIT_REPO="https://github.com/YOUR_USERNAME/starbucks-coupon.git"

echo ""
echo "[1/5] 安装依赖..."
if ! command -v node &> /dev/null; then
    echo "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
if ! command -v nginx &> /dev/null; then
    apt-get install -y nginx
fi
if ! command -v git &> /dev/null; then
    apt-get install -y git
fi

echo "[2/5] 克隆代码..."
if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" && git pull
else
    git clone "$GIT_REPO" "$APP_DIR"
fi

echo "[3/5] 安装项目依赖..."
cd "$APP_DIR"
npm install --production

echo "[4/5] 配置 Nginx 反向代理..."
cat > /etc/nginx/sites-available/starbucks-coupon << 'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/starbucks-coupon /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "[5/5] 启动应用 (PM2)..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi
pm2 delete starbucks-coupon 2>/dev/null || true
pm2 start server.js --name starbucks-coupon --time
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "============================================"
echo "  部署完成！"
echo "============================================"
echo "  访问地址: http://<你的VPS_IP>"
echo "  管理后台: http://<你的VPS_IP>/admin.html"
echo "  PM2管理:  pm2 status"
echo "  查看日志: pm2 logs starbucks-coupon"
echo "============================================"
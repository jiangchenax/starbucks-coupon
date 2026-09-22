FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json ./
RUN npm ci --production

# 复制代码
COPY server.js ./
COPY public/ ./public/

# 创建 sessions 目录
RUN mkdir -p /app/sessions

EXPOSE 3456

CMD ["node", "server.js"]
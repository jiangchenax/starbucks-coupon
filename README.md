# ☕ 星巴克卡券管理中心

复刻 [starbuck.youzan.tech](https://starbuck.youzan.tech)，对接星巴克官方 BFF API (`bff.starbucks.com.cn`) 的卡券管理系统。

## 功能

| 功能 | 说明 |
|------|------|
| 扫码登录 | 生成二维码 → 扫码确认 → 自动同步卡券 |
| 卡券列表 | 从星巴克 API 拉取好礼券、星礼卡 |
| 一键复制 | 复制全部卡券号 |
| 账号管理 | 多账号切换、删除账号 |
| API 代理 | 后端透传星巴克 BFF API |

## 从 APK 提取的 API 端点

```
基础 URL: https://bff.starbucks.com.cn

登录:
  POST /app-bff-api/login                                    # 用户登录
  POST /app-bff-api/auth/login/qrcode/status                 # 扫码状态
  POST /app-bff-api/auth/login/qrcode/authorize              # 扫码授权
  POST /app-bff-api/auth/v2/user/detail                      # 用户信息

卡券:
  GET  /common-api/v1/coupons                                # 好礼券列表
  GET  /common-api/v1/coupon/available                       # 检查券可用性

星礼卡:
  POST /app-bff-api/auth/cards/getCards                      # 星礼卡列表
  POST /app-bff-api/auth/cards/msr/detail                    # 星享卡详情
```

## 部署

### 方式一：Docker
```bash
git clone https://github.com/YOUR_USERNAME/starbucks-coupon.git
cd starbucks-coupon
docker-compose up -d
```

### 方式二：PM2 + Nginx
```bash
chmod +x deploy.sh && ./deploy.sh
```

### 方式三：手动
```bash
npm install && npm start
```

## 使用

1. 打开 `http://<IP>:3456`
2. 点击「添加账号」→ 扫码
3. 卡券自动同步
4. 点击「复制全部卡券」一键复制

## 管理后台

访问 `http://<IP>:3456/admin.html` 可配置真实星巴克 Token 实现完整同步。

## 技术栈

- Node.js + Express
- Session 管理
- QR Code 生成
- BFF API 代理
- Tailwind CSS 前端
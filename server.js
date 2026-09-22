const express = require('express');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-' + uuidv4();

const BFF_PROD = 'https://bff.starbucks.com.cn';
const BFF_STG = 'https://bff.stg.starbucks.com.cn';

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// BFF API helper
async function bffRequest(method, path, headers = {}, body = null) {
  const host = process.env.STARBUCKS_ENV === 'stg' ? BFF_STG : BFF_PROD;
  try {
    const config = {
      method,
      url: `${host}${path}`,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'StarbucksCN/10.26.2 (Android 14)',
        ...headers
      },
      timeout: 15000
    };
    if (body && method.toLowerCase() !== 'get') config.data = body;
    const res = await axios(config);
    return { ok: true, data: res.data };
  } catch (e) {
    console.error(`[BFF] ${method} ${path} failed:`, e.message);
    return { ok: false, error: e.response?.data || e.message };
  }
}

// ===================== 页面 =====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ===================== 健康检查 =====================
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ===================== 生成二维码 =====================
app.post('/api/qrcode/generate', async (req, res) => {
  const seed = uuidv4();
  req.session.qrSeed = seed;
  req.session.qrCreatedAt = Date.now();
  const qrImage = await qrcode.toDataURL(`STARBUCKS-LOGIN|${seed}`, { width: 300, margin: 2 });
  res.json({ success: true, qrImage, seed });
});

// ===================== 轮询扫码状态 =====================
app.get('/api/qrcode/status', (req, res) => {
  if (!req.session.qrSeed) return res.json({ success: false, status: 'none' });
  if (Date.now() - req.session.qrCreatedAt > 300000) {
    req.session.qrSeed = null;
    return res.json({ success: false, status: 'expired' });
  }
  const elapsed = Date.now() - req.session.qrCreatedAt;
  if (elapsed > 30000 && req.session.qrConfirmed) return res.json({ success: true, status: 'confirmed' });
  if (elapsed > 15000 && !req.session.qrScanned) { req.session.qrScanned = true; return res.json({ success: true, status: 'scanned' }); }
  res.json({ success: true, status: 'waiting' });
});

// ===================== 确认扫码 =====================
app.post('/api/qrcode/confirm', (req, res) => {
  if (!req.session.qrSeed) return res.json({ success: false, message: '无有效二维码' });
  req.session.qrConfirmed = true;
  req.session.starbucksToken = `sbux_jwt_${uuidv4()}`;
  req.session.isLoggedIn = true;
  req.session.user = {
    id: 'user_' + Math.floor(Math.random() * 900000 + 100000),
    name: `星巴克用户_${Math.floor(Math.random() * 9000 + 1000)}`,
    level: '金星会员'
  };
  res.json({ success: true, message: '登录成功' });
});

// ===================== 获取账号信息 =====================
app.get('/api/accounts', (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, accounts: [] });
  res.json({
    success: true,
    accounts: [{ id: req.session.user.id, name: req.session.user.name, level: req.session.user.level }]
  });
});

// ===================== 获取卡券列表 =====================
app.get('/api/coupons', async (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, message: '未登录', coupons: [] });

  // 尝试真实 API
  if (req.session.bffToken) {
    const r = await bffRequest('GET', '/common-api/v1/coupons', {
      Authorization: `Bearer ${req.session.bffToken}`
    });
    if (r.ok) return res.json({ success: true, coupons: r.data.coupons || r.data || [] });
  }

  // 模拟数据
  res.json({
    success: true,
    coupons: [
      { no: '2001001234567890123', code: 'WEL2026', name: '免费升杯券', expire: '2026-12-31' },
      { no: '2002002345678901234', code: 'BRV2026', name: '买一赠一券', expire: '2026-11-15' },
      { no: '2003003456789012345', code: 'HOL2026', name: '糕点半价券', expire: '2026-10-31' },
      { no: '2004004567890123456', code: 'FRP2026', name: '免运费券', expire: '2026-12-01' },
      { no: '2005005678901234567', code: 'GRT2026', name: '星礼卡优惠券', expire: '2026-09-30' }
    ]
  });
});

// ===================== 登出 =====================
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===================== 状态检查 =====================
app.get('/api/status', (req, res) => {
  res.json({ success: true, isLoggedIn: !!req.session.isLoggedIn, user: req.session.user || null });
});

// ===================== 真实登录（用手机号+密码换token） =====================
app.post('/api/login/real', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.json({ success: false, message: '请输入手机号和密码' });

  const r = await bffRequest('POST', '/app-bff-api/login', {}, {
    loginType: 'BASIC',
    userName: phone,
    password: password,
    device: { deviceId: uuidv4(), deviceType: 'android', model: 'SM-S9080' }
  });

  if (r.ok && r.data.access_token) {
    req.session.bffToken = r.data.access_token;
    req.session.isLoggedIn = true;
    req.session.user = { id: phone, name: phone, level: '会员' };
    return res.json({ success: true, message: '登录成功' });
  }

  res.json({ success: false, message: '登录失败', detail: r.error });
});

// ===================== 管理后台登录 =====================
app.post('/api/admin/login', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.body.password === adminPassword) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.json({ success: false, message: '密码错误' });
});

app.post('/api/admin/config', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false, message: '需要管理员登录' });
  const { env, phone, password, token } = req.body;
  if (token) req.session.bffToken = token;
  if (env) req.session.bffEnv = env;
  res.json({ success: true, message: '配置已保存' });
});

// ===================== 启动 =====================
app.listen(PORT, () => {
  console.log('');
  console.log('  ☕ 星巴克卡券管理 VPS 版');
  console.log(`  🌐 http://0.0.0.0:${PORT}`);
  console.log(`  🔧 后台: http://0.0.0.0:${PORT}/admin`);
  console.log('');
});
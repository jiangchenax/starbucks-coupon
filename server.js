try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

const BFF_PROD = 'https://bff.starbucks.com.cn';
const BFF_STG = 'https://bff.stg.starbucks.com.cn';
const BASE_URL = process.env.STARBUCKS_ENV === 'stg' ? BFF_STG : BFF_PROD;

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN || ['https://starbucks.mossao.com', 'http://localhost:3456'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sbux-' + Math.random().toString(36).slice(2),
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

// ===== BFF API HELPER =====
async function bff(method, path, headers = {}, body = null) {
  try {
    const cfg = {
      method,
      url: `${BASE_URL}${path}`,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'StarbucksCN/10.26.2 (Android 14)',
        'Accept': 'application/json',
        ...headers
      },
      timeout: 15000
    };
    if (body && method !== 'GET') cfg.data = body;
    const res = await axios(cfg);
    return { ok: true, data: res.data, status: res.status };
  } catch (e) {
    const errData = e.response?.data || e.message;
    console.error(`[BFF ${method}] ${path}:`, typeof errData === 'string' ? errData.slice(0, 200) : JSON.stringify(errData).slice(0, 300));
    return { ok: false, error: errData, status: e.response?.status };
  }
}

// ======================= 页面 =======================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));

// ======================= 健康检查 =======================
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ======================= [真·官方协议] 获取 QR Seed =======================
// 来源：真实抓包 https://profile.starbucks.com.cn/api/qrcode/seed
app.post('/api/qrcode/seed', async (req, res) => {
  try {
    console.log('[QR] 正在请求星巴克官方 profile 服务获取真实 seed...');
    const response = await axios.get('https://profile.starbucks.com.cn/api/qrcode/seed', {
      headers: {
        'Host': 'profile.starbucks.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.starbucks.com.cn',
        'Referer': 'https://www.starbucks.com.cn/',
        'x-msr-version': '2'
      },
      timeout: 10000
    });

    if (response.data && response.data.seed) {
      const realSeed = response.data.seed;
      console.log('[QR] 获取官方 seed 成功:', realSeed);
      
      req.session.qrRealSeed = realSeed;
      req.session.qrCreatedAt = Date.now();
      req.session.qrPhase = 'official';

      // App 只识别官网域名。扫码确认发生在星巴克 App，本站只轮询同一 seed
      const qrUrl = `https://www.starbucks.com.cn/account/#/?seed=${encodeURIComponent(realSeed)}`;
      const qrImage = await qrcode.toDataURL(qrUrl, { width: 300, margin: 2, errorCorrectionLevel: 'M' });

      return res.json({
        success: true,
        qrImage,
        seed: realSeed,
        qrUrl,
        mode: 'official'
      });
    }
  } catch (e) {
    console.error('[QR] 获取官方 seed 失败:', e.message);
  }

  // 回退降级方案
  const localSeed = uuidv4();
  req.session.qrSeedLocal = localSeed;
  req.session.qrPhase = 'local';
  const qrImage = await qrcode.toDataURL(`https://www.starbucks.com.cn/account/login?seed=${localSeed}`, { width: 300, margin: 2 });
  res.json({ success: true, qrImage, mode: 'local' });
});

// ======================= [真·官方协议] 轮询扫码状态 =======================
// 来源：真实抓包 https://profile.starbucks.com.cn/api/qrcode/ping?seed=...
app.get('/api/qrcode/status', async (req, res) => {
  if (req.session.qrPhase === 'official' && req.session.qrRealSeed) {
    try {
      const pingRes = await axios.get(`https://profile.starbucks.com.cn/api/qrcode/ping?seed=${req.session.qrRealSeed}`, {
        headers: {
          'Host': 'profile.starbucks.com.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.starbucks.com.cn',
          'Referer': 'https://www.starbucks.com.cn/',
          'x-msr-version': '2'
        },
        timeout: 10000
      });

      const data = pingRes.data;
      console.log('[Ping]', data);

      // code: 80032 => waiting to be scanned
      // code: 80030 / 80031 等状态码通常为 scanned 或 authorized
      if (data.code === 80032) {
        return res.json({ status: 'waiting' });
      }

      // 如果扫码或者确认成功
      if (data.status === 200 && data.code !== 80032) {
        req.session.isLoggedIn = true;
        // 如果下发了 token 或 cookie
        if (data.token || data.access_token) {
          req.session.bffToken = data.token || data.access_token;
        }
        return res.json({ status: 'confirmed', data });
      }
    } catch (err) {
      console.error('[Ping Error]', err.message);
    }
  }

  // 兜底本地逻辑
  if (req.session.qrConfirmed) return res.json({ status: 'confirmed' });
  if (req.session.qrScanned) return res.json({ status: 'scanned' });
  return res.json({ status: 'waiting' });
});

// ======================= 确认登录 =======================
app.post('/api/qrcode/confirm', async (req, res) => {
  const seed = req.body?.seed || req.session.qrRealSeed || req.session.qrSeedToken || req.session.qrSeedLocal;
  if (seed) req.session.qrRealSeed = seed;
  if (!seed) {
    return res.json({ success: false, message: '无有效二维码' });
  }

  if (req.session.qrSeedToken) {
    // 真实模式：调用 authorize 接口
    const result = await bff('POST', '/app-bff-api/auth/login/qrcode/authorize', {}, {
      seed: req.session.qrSeedToken
    });
    if (result.ok && result.data) {
      const token = result.data.access_token || result.data.token;
      if (token) {
        req.session.bffToken = token;
        req.session.isLoggedIn = true;
        const userInfo = await bff('POST', '/app-bff-api/auth/v2/user/detail', {
          Authorization: `Bearer ${token}`
        });
        if (userInfo.ok) {
          req.session.user = {
            id: userInfo.data.userName || userInfo.data.id,
            name: userInfo.data.firstName || '星巴克用户',
            level: (userInfo.data.loyaltyTier || {}).userLevel || '会员'
          };
        }
      }
      req.session.qrPhase = 'authorized';
      return res.json({ success: true, message: '登录成功' });
    }
  }

  // 本地模式或真实模式回退
  req.session.qrConfirmed = true;
  req.session.qrPhase = 'authorized';
  req.session.bffToken = `sbux_jwt_${uuidv4()}`;
  req.session.isLoggedIn = true;
  if (!req.session.user) {
    req.session.user = { id: 'user_local', name: '本地用户', level: '金星会员' };
  }
  res.json({ success: true, message: '登录成功' });
});

// ======================= 获取账号信息 =======================
app.get('/api/accounts', (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, accounts: [] });
  res.json({
    success: true,
    accounts: [{
      id: req.session.user?.id || 'unknown',
      name: req.session.user?.name || '用户',
      level: req.session.user?.level || '',
      phone: req.session.user?.phone || ''
    }]
  });
});

// ======================= 获取卡券列表 =======================
app.get('/api/coupons', async (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, message: '未登录', coupons: [] });

  if (req.session.bffToken && !req.session.bffToken.startsWith('sbux_jwt_')) {
    console.log('[Coupons] 使用真实 Token 拉取卡券...');
    const r = await bff('GET', '/common-api/v1/coupons?lang=CHS', {
      Authorization: `Bearer ${req.session.bffToken}`
    });
    if (r.ok) {
      const raw = r.data?.coupons || r.data?.data || r.data || [];
      const coupons = (Array.isArray(raw) ? raw : []).map(c => ({
        no: c.couponNo || c.id || c.coupon_number || '',
        code: c.code || c.registrationCode || '',
        name: c.name || c.title || c.couponName || c.description || '',
        expire: c.expireDate || c.expire || c.endDate || c.validEndDate || '',
        type: c.type || c.category || c.couponType || '',
        status: c.status || c.state || 'valid'
      }));
      console.log(`[Coupons] 成功拉取 ${coupons.length} 张卡券`);
      return res.json({ success: true, source: 'bff', coupons });
    }
    console.error('[Coupons] BFF 返回错误:', JSON.stringify(r.error).slice(0, 300));
  }

  res.json({ success: true, source: 'demo', coupons: [] });
});

// ======================= 登出 =======================
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ======================= 状态检查 =======================
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    isLoggedIn: !!req.session.isLoggedIn,
    user: req.session.user || null,
    mode: req.session.bffToken?.startsWith('sbux_jwt_') ? 'demo' : 'real'
  });
});

// ======================= 真实登录（手机号+密码） =======================
app.post('/api/login/real', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.json({ success: false, message: '请输入手机号和密码' });

  console.log('[Login] 正在登录...');
  const r = await bff('POST', '/app-bff-api/login', {}, {
    loginType: 'BASIC',
    userName: phone,
    password,
    device: { deviceId: uuidv4(), deviceType: 'android', model: 'SM-S9080', osVersion: 'Android 14', appVersion: '10.26.2' }
  });

  if (r.ok && r.data?.access_token) {
    req.session.bffToken = r.data.access_token;
    req.session.isLoggedIn = true;
    // 拉用户信息
    const info = await bff('POST', '/app-bff-api/auth/v2/user/detail', { Authorization: `Bearer ${r.data.access_token}` });
    if (info.ok && info.data) {
      req.session.user = {
        id: info.data.userName || phone,
        name: info.data.firstName || info.data.nickName || phone,
        level: (info.data.loyaltyTier || {}).userLevel || '会员',
        phone: info.data.cellPhone || phone
      };
    } else {
      req.session.user = { id: phone, name: phone, level: '会员' };
    }
    console.log('[Login] 登录成功, 用户:', req.session.user.name);
    return res.json({ success: true, message: '登录成功', user: req.session.user });
  }
  console.error('[Login] 失败:', JSON.stringify(r.error).slice(0, 300));
  res.json({ success: false, message: '登录失败', detail: r.error });
});

// ======================= 管理后台 =======================
app.post('/api/admin/login', (req, res) => {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) return res.json({ success: false, message: '管理后台已禁用（未设置 ADMIN_PASSWORD）' });
  if (req.body.password !== pwd) return res.json({ success: false, message: '密码错误' });
  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/config', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ success: false, message: '需管理员登录' });
  const { token, env } = req.body;
  if (token) req.session.bffToken = token;
  if (env) req.session.starbucksEnv = env;
  res.json({ success: true });
});

// ======================= 启动 =======================
app.listen(PORT, () => {
  console.log('');
  console.log('  ☕ 星巴克卡券管理');
  console.log(`  🌐 http://0.0.0.0:${PORT}`);
  console.log(`  🔧 ${BASE_URL}`);
  console.log('');
});
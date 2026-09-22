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

// ======================= 健康检查 =======================
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ======================= [真] 获取 QR Seed =======================
// 对应 App 内: /app-bff-api/auth/pay/getQrSeed
app.post('/api/qrcode/seed', async (req, res) => {
  const result = await bff('POST', '/app-bff-api/auth/pay/getQrSeed', {}, {
    device: {
      deviceId: uuidv4(),
      deviceType: 'android',
      model: 'SM-S9080',
      osVersion: 'Android 14',
      appVersion: '10.26.2'
    }
  });

  if (result.ok) {
    const { qrSeedToken, qrOpenId, seedExpireTime } = result.data;
    // 保存到会话
    req.session.qrSeedToken = qrSeedToken;
    req.session.qrOpenId = qrOpenId;
    req.session.qrSeedExpires = seedExpireTime || Date.now() + 300000;
    req.session.qrPhase = 'generated';

    // 生成二维码内容：DRQ|<openId>|<encryptedCode>
    // 加密 code 由客户端 TOTP 算法生成 (Lyg/c + Lqh/c)
    // 这里先用 seedToken 明文，若失败则需自行实现 TOTP
    const qrContent = `DRQ|${qrOpenId}|${qrSeedToken}`;
    const qrImage = await qrcode.toDataURL(qrContent, { width: 300, margin: 2 });

    return res.json({
      success: true,
      qrImage,
      qrOpenId,
      expiresIn: Math.floor((req.session.qrSeedExpires - Date.now()) / 1000)
    });
  }

  // 如果 getQrSeed 不可用，回退到本地 seed
  const localSeed = uuidv4();
  req.session.qrSeedLocal = localSeed;
  req.session.qrPhase = 'local';
  const qrImage = await qrcode.toDataURL(`SBUX_LOGIN|${localSeed}`, { width: 300, margin: 2 });
  res.json({
    success: true,
    qrImage,
    mode: 'local',
    localSeed,
    note: 'getQrSeed 暂时不可用，使用本地模式'
  });
});

// ======================= [真] 轮询扫码状态 =======================
// 对应 App 内: POST /app-bff-api/auth/login/qrcode/status
app.get('/api/qrcode/status', async (req, res) => {
  const phase = req.session.qrPhase;

  // 本地模式：模拟流程
  if (phase === 'local') {
    if (!req.session.qrSeedLocal) return res.json({ status: 'expired' });
    const elapsed = Date.now() - (req.session.qrCreatedAt || Date.now());
    if (elapsed > 300000) {
      req.session.qrPhase = null;
      return res.json({ status: 'expired' });
    }
    if (req.session.qrConfirmed) return res.json({ status: 'authorized' });
    if (req.session.qrScanned) return res.json({ status: 'scanned' });
    // 自动模拟扫码: 15s 后标记已扫码, 30s 后标记已确认
    if (elapsed > 30000) {
      req.session.qrScanned = true;
      req.session.qrConfirmed = true;
      req.session.qrPhase = 'authorized';
      return res.json({ status: 'authorized', token: `sbux_${uuidv4()}` });
    }
    if (elapsed > 15000) {
      req.session.qrScanned = true;
      return res.json({ status: 'scanned' });
    }
    return res.json({ status: 'waiting' });
  }

  // 真实模式：轮询星巴克 API
  if (!req.session.qrSeedToken) return res.json({ status: 'expired' });
  if (Date.now() > req.session.qrSeedExpires) {
    req.session.qrPhase = null;
    return res.json({ status: 'expired' });
  }

  const result = await bff('POST', '/app-bff-api/auth/login/qrcode/status', {}, {
    seed: req.session.qrSeedToken
  });

  if (result.ok && result.data) {
    const status = result.data.status || result.data;
    if (status === 'authorized' || status === 'confirmed' || result.data.access_token) {
      // 授权成功，拿到 token
      const token = result.data.access_token || result.data.token;
      if (token) {
        req.session.bffToken = token;
        req.session.isLoggedIn = true;

        // 获取用户信息
        const userInfo = await bff('POST', '/app-bff-api/auth/v2/user/detail', {
          Authorization: `Bearer ${token}`
        });
        if (userInfo.ok) {
          req.session.user = {
            id: userInfo.data.userName || userInfo.data.id || 'unknown',
            name: userInfo.data.firstName || userInfo.data.nickName || '星巴克用户',
            level: (userInfo.data.loyaltyTier || {}).userLevel || '会员',
            phone: userInfo.data.cellPhone || ''
          };
        } else {
          req.session.user = { id: req.session.qrOpenId, name: '星巴克用户', level: '会员' };
        }
      }
      req.session.qrPhase = 'authorized';
      return res.json({ status: 'authorized', token });
    }
    if (status === 'scanned') {
      req.session.qrScanned = true;
      return res.json({ status: 'scanned' });
    }
    return res.json({ status: 'waiting' });
  }

  return res.json({ status: 'waiting' });
});

// ======================= 确认登录 =======================
app.post('/api/qrcode/confirm', async (req, res) => {
  if (!req.session.qrSeedToken && !req.session.qrSeedLocal) {
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
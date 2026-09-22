try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const puppeteer = require('puppeteer');
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

app.post('/api/qrcode/use', (req, res) => {
  const seed = String(req.body?.seed || '').trim();
  if (!seed) return res.status(400).json({ success: false, message: '缺少 seed' });
  req.session.qrRealSeed = seed;
  req.session.qrPhase = 'official';
  req.session.qrCreatedAt = Date.now();
  console.log('[QR] use seed', seed);
  res.json({ success: true });
});

// ======================= [真·官方协议] 获取 QR Seed =======================
// 来源：真实抓包 https://profile.starbucks.com.cn/api/qrcode/seed
const sessions = new Map();

async function browserSeed() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  let seed = '';
  page.on('response', async (resp) => {
    if (!resp.url().includes('/api/qrcode/seed')) return;
    try {
      const data = await resp.json();
      if (data.seed) seed = data.seed;
    } catch (_) {}
  });
  await page.goto('https://www.starbucks.com.cn/account/#/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await new Promise(r => setTimeout(r, 5000));
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, a, div, span')];
    const hit = nodes.find(n => /扫码|二维码/.test(n.innerText || ''));
    if (hit) { hit.click(); return hit.innerText.slice(0, 20); }
    return '';
  }).catch(() => '');
  console.log('[QR] page', page.url(), 'click', clicked || 'none');
  for (let i = 0; i < 30 && !seed; i++) await new Promise(r => setTimeout(r, 500));
  if (!seed) {
    await browser.close();
    throw new Error('no seed');
  }
  return { browser, page, seed };
}

async function readCoupons(page) {
  return page.evaluate(async () => {
    const urls = [
      'https://profile.starbucks.com.cn/api/Customers/rewards?status=active&pageNum=1&pageSize=50',
      'https://profile.starbucks.com.cn/api/Customers/rewards?status=ALL&pageNum=1&pageSize=50'
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', 'x-msr-version': '2' } });
        const data = await r.json();
        const raw = data.data || data.rewards || data.coupons || data;
        if (Array.isArray(raw) && raw.length) return raw;
        if (Array.isArray(data) && data.length) return data;
      } catch (_) {}
    }
    return [];
  });
}

app.post('/api/qrcode/seed', async (req, res) => {
  try {
    console.log('[QR] 浏览器自动获取官方 seed...');
    const opened = await browserSeed();
    const realSeed = opened.seed;
    sessions.set(realSeed, opened);
    console.log('[QR] seed', realSeed);
    req.session.qrRealSeed = realSeed;
    req.session.qrCreatedAt = Date.now();
    req.session.qrPhase = 'official';
    const qrImage = await qrcode.toDataURL(realSeed, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
    return res.json({ success: true, qrImage, seed: realSeed, mode: 'browser' });
  } catch (e) {
    console.error('[QR] browser', e.message);
    return res.status(500).json({ success: false, message: '官网二维码获取失败，请重试' });
  }
});

// ======================= [真·官方协议] 轮询扫码状态 =======================
// 来源：真实抓包 https://profile.starbucks.com.cn/api/qrcode/ping?seed=...
app.get('/api/qrcode/status', async (req, res) => {
  if (req.session.qrPhase === 'official' && req.session.qrRealSeed) {
    try {
      const smToken = process.env.SM_TOKEN || '';
      const pingRes = await axios.get(`https://profile.starbucks.com.cn/api/qrcode/ping?seed=${req.session.qrRealSeed}`, {
        headers: {
          'Host': 'profile.starbucks.com.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.starbucks.com.cn',
          'Referer': 'https://www.starbucks.com.cn/',
          'x-msr-version': '2',
          ...(smToken ? { 'Sm-Token': smToken } : {})
        },
        timeout: 10000
      });

      const data = pingRes.data;
      console.log('[Ping]', data);

      // 80032 waiting, 80033 scanned, 80035 expired, token 出现即授权成功
      if (data.token && !req.session.qrExchanging) {
        req.session.qrExchanging = true;
        try {
          const oauth = await axios.post('https://bff.starbucks.com.cn/web/login/oauth/access_token', {
            code: data.token,
            remember_me: false,
            grant_type: 'authorization_code'
          }, {
            headers: {
              'x-msr-version': '2',
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Origin: 'https://www.starbucks.com.cn',
              Referer: 'https://www.starbucks.com.cn/'
            },
            timeout: 15000
          });
          req.session.bffToken = oauth.data?.access_token || data.token;
          req.session.oauthRaw = oauth.data;
          console.log('[OAuth] ok');
        } catch (e) {
          console.error('[OAuth]', e.response?.data || e.message);
          req.session.bffToken = data.token;
        }
        req.session.isLoggedIn = true;
        req.session.user = { id: 'qr', name: '扫码用户', level: '会员' };
        req.session.qrPhase = 'done';
        const opened = sessions.get(req.session.qrRealSeed);
        if (opened) {
          req.session.coupons = (await readCoupons(opened.page)).map(c => ({
            no: c.couponNo || c.benefitId || c.id || c.voucherNum || '',
            code: c.code || c.couponCode || c.poskey || c.formattedPoskey || c.couponNo || '',
            name: c.title || c.name || c.benefitName || '好礼券',
            expire: c.expiryDate || c.expireDate || c.validEndTime || '',
            type: c.status || '好礼券'
          }));
          console.log('[Coupons] browser', req.session.coupons.length);
          await opened.browser.close();
          sessions.delete(req.session.qrRealSeed);
        }
        return res.json({ status: 'confirmed', count: (req.session.coupons || []).length });
      }
      if (req.session.qrPhase === 'done') return res.json({ status: 'confirmed' });
      if (data.code === 80033) return res.json({ status: 'scanned' });
      if (data.code === 80035) return res.json({ status: 'expired' });
      if (data.code === 80032) return res.json({ status: 'waiting' });
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

async function loadCoupons(token) {
  const smToken = process.env.SM_TOKEN || '';
  const headers = {
    'x-msr-version': '2',
    Accept: 'application/json',
    Origin: 'https://www.starbucks.com.cn',
    Referer: 'https://www.starbucks.com.cn/',
    ...(smToken ? { 'Sm-Token': smToken } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  const urls = [
    'https://profile.starbucks.com.cn/api/Customers/rewards?status=active&pageNum=1&pageSize=50',
    'https://bff.starbucks.com.cn/common-api/v1/coupons?lang=CHS&channel=ALL'
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers, timeout: 25000 });
      const raw = r.data?.data || r.data?.rewards || r.data?.coupons || r.data || [];
      const list = Array.isArray(raw) ? raw : [];
      console.log('[Coupons]', url, list.length, JSON.stringify(r.data).slice(0, 300));
      if (list.length || r.data) {
        return list.map(c => ({
          no: c.couponNo || c.benefitId || c.id || c.voucherNum || '',
          code: c.code || c.couponCode || c.poskey || c.formattedPoskey || '',
          name: c.title || c.name || c.benefitName || '好礼券',
          expire: c.expiryDate || c.expireDate || c.validEndTime || '',
          type: c.status || c.type || '好礼券'
        }));
      }
    } catch (e) {
      console.error('[Coupons]', url, e.response?.status || e.message, JSON.stringify(e.response?.data || '').slice(0, 200));
    }
  }
  return [];
}

// ======================= 获取卡券列表 =======================
app.get('/api/coupons', async (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, message: '未登录', coupons: [] });
  if (Array.isArray(req.session.coupons) && req.session.coupons.length) {
    return res.json({ success: true, coupons: req.session.coupons });
  }
  const coupons = await loadCoupons(req.session.bffToken);
  req.session.coupons = coupons;
  return res.json({ success: true, coupons });
});

app.get('/api/coupons-disabled', async (req, res) => {
  if (!req.session.isLoggedIn) return res.json({ success: false, message: '未登录', coupons: [] });

  try {
    const smToken = process.env.SM_TOKEN || '';
    const r = await axios.get('https://profile.starbucks.com.cn/api/Customers/rewards?status=active&pageNum=1&pageSize=50', {
      headers: {
        'x-msr-version': '2',
        'X-API-Version': '2',
        Accept: 'application/json',
        Origin: 'https://www.starbucks.com.cn',
        Referer: 'https://www.starbucks.com.cn/',
        ...(smToken ? { 'Sm-Token': smToken } : {}),
        ...(req.session.bffToken ? { Authorization: `Bearer ${req.session.bffToken}` } : {})
      },
      timeout: 15000
    });
    const raw = r.data?.data || r.data?.rewards || r.data || [];
    const list = Array.isArray(raw) ? raw : [];
    const coupons = list.map(c => ({
      no: c.couponNo || c.benefitId || c.id || c.voucherNum || '',
      code: c.code || c.couponCode || c.poskey || c.formattedPoskey || '',
      name: c.title || c.name || c.benefitName || c.description || '好礼券',
      expire: c.expiryDate || c.expireDate || c.validEndTime || '',
      type: c.status || c.type || '好礼券'
    }));
    console.log('[Coupons]', coupons.length, JSON.stringify(r.data).slice(0, 400));
    return res.json({ success: true, source: 'profile', coupons, raw: r.data });
  } catch (e) {
    console.error('[Coupons]', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 400));
    return res.json({ success: false, coupons: [], error: e.response?.data || e.message });
  }
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
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 5590;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USER_DATA_DIR = path.join(DATA_DIR, 'user-data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ---------- 账号体系（登录即注册） ---------- */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话 30 天有效
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 请求体上限 5MB（关注名单 + 提醒设置）
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 登录尝试统计窗口
const AUTH_MAX_ATTEMPTS = 30; // 每 IP 每窗口最多尝试次数
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/; // 中文 / 字母 / 数字 / _ / -

// 内存限速计数：ip -> { count, resetAt }
const authAttempts = new Map();

function ensureStore() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

// 原子写入：先写临时文件再重命名，避免写一半损坏
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function loadUsers() {
  return readJson(USERS_FILE, { users: {} });
}

function saveUsers(db) {
  writeJsonAtomic(USERS_FILE, db);
}

function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

function saveSessions(sessions) {
  writeJsonAtomic(SESSIONS_FILE, sessions);
}

function userDataFile(userId) {
  // userId 为服务端生成的 UUID，不含路径分隔符，直接拼接安全
  return path.join(USER_DATA_DIR, String(userId) + '.json');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function publicUser(user) {
  return { name: user.name, createdAt: user.createdAt };
}

function clientIp(request) {
  return request.socket.remoteAddress || 'unknown';
}

// 登录尝试限速：窗口内超过次数返回 false
function allowAuthAttempt(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= AUTH_MAX_ATTEMPTS;
}

function pruneSessions(sessions) {
  const now = Date.now();
  for (const [token, session] of Object.entries(sessions)) {
    if (!session || session.expiresAt < now) delete sessions[token];
  }
}

// 从多个通道读取会话令牌：Authorization 头、自定义头、Cookie
// 某些部署网关会剥离 Authorization，因此保留多条通道
function readToken(request) {
  const header = String(request.headers.authorization || '');
  const bearer = header.match(/^Bearer ([A-Za-z0-9]{64})$/);
  if (bearer) return bearer[1];
  const alt = String(request.headers['x-auth-token'] || '').trim();
  if (/^[A-Za-z0-9]{64}$/.test(alt)) return alt;
  const cookie = String(request.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)nba_token=([A-Za-z0-9]{64})/);
  if (match) return match[1];
  return null;
}

// 解析当前登录用户，无效返回 null
function userFromRequest(request) {
  const token = readToken(request);
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  return { id: session.userId, name: session.name };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

/**
 * 登录即注册：账号不存在则自动创建，存在则校验密码。
 * 密码使用 scrypt + 随机盐哈希存储，不明文落盘。
 */
async function handleAuth(request, response) {
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!USERNAME_RE.test(username)) {
    return sendJson(response, 400, { error: '用户名需为 2-20 位中文、字母、数字、下划线或连字符' });
  }
  if (password.length < 6) {
    return sendJson(response, 400, { error: '密码至少 6 位' });
  }
  if (!allowAuthAttempt(clientIp(request))) {
    return sendJson(response, 429, { error: '尝试过于频繁，请 15 分钟后再试' });
  }

  const key = username.toLowerCase();
  const db = loadUsers();
  let user = db.users[key];
  let created = false;

  if (!user) {
    // 首次使用：自动注册
    const salt = crypto.randomBytes(16).toString('hex');
    user = {
      id: crypto.randomUUID(),
      name: username,
      salt,
      hash: hashPassword(password, salt),
      createdAt: Date.now(),
    };
    db.users[key] = user;
    saveUsers(db);
    created = true;
  } else {
    const expected = Buffer.from(user.hash, 'hex');
    const actual = crypto.scryptSync(password, user.salt, 64);
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!ok) {
      return sendJson(response, 401, { error: '密码不正确，请重试' });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  pruneSessions(sessions);
  sessions[token] = {
    userId: user.id,
    name: user.name,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  saveSessions(sessions);

  return sendJson(response, 200, { token, user: publicUser(user), created });
}

async function handleApi(request, response, pathname) {
  if (request.method === 'POST' && pathname === '/api/auth') {
    return handleAuth(request, response);
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    const header = String(request.headers.authorization || '');
    const match = header.match(/^Bearer ([A-Za-z0-9]{64})$/);
    if (match) {
      const sessions = loadSessions();
      if (sessions[match[1]]) {
        delete sessions[match[1]];
        saveSessions(sessions);
      }
    }
    return sendJson(response, 200, { ok: true });
  }

  // 以下接口都需要登录
  const user = userFromRequest(request);
  if (!user) {
    return sendJson(response, 401, { error: '未登录或登录已过期' });
  }

  if (request.method === 'GET' && pathname === '/api/me') {
    return sendJson(response, 200, { user: publicUser({ name: user.name, createdAt: null }) });
  }

  if (request.method === 'GET' && pathname === '/api/data') {
    const data = readJson(userDataFile(user.id), null);
    return sendJson(response, 200, { data: data || {} });
  }

  if (request.method === 'PUT' && pathname === '/api/data') {
    const body = await readBody(request);
    const data = body && typeof body === 'object' ? body : {};
    const payload = {
      players: Array.isArray(data.players) ? data.players : [],
      hotThreshold: Number.isFinite(data.hotThreshold) ? data.hotThreshold : 5,
      view: data.view === 'teams' || data.view === 'players' ? data.view : 'players',
      hotAlertStore: data.hotAlertStore && typeof data.hotAlertStore === 'object' ? data.hotAlertStore : {},
      updatedAt: Date.now(),
    };
    writeJsonAtomic(userDataFile(user.id), payload);
    return sendJson(response, 200, { ok: true, updatedAt: payload.updatedAt });
  }

  return sendJson(response, 404, { error: '接口不存在' });
}

/* ---------- 静态文件服务 ---------- */

function serveStatic(pathname, request, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);

  if (!filePath.startsWith(ROOT + path.sep) || filePath.startsWith(DATA_DIR + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    // app.js 约 152KB、styles.css 约 46KB，每次打开都重下很浪费；
    // 用强 ETag + no-cache（每次校验、未变返 304），既省流量又不会拿到旧版本。
    const etag = '"' + crypto.createHash('sha1').update(content).digest('hex').slice(0, 20) + '"';
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    response.end(content);
  });
}

/* ---------- ESPN 数据代理（解决浏览器直连的 CORS 限制） ---------- */

// 只代理 ESPN 这两个域名下的 GET 请求，不作为开放代理
const ESPN_HOSTS = {
  site: 'site.api.espn.com',
  web: 'site.web.api.espn.com',
};

/* ---------- 分层缓存：按「数据还会不会变」决定 TTL ---------- */

// NBA 数据的可变性差异极大：终场技术统计不会再变，进行中的比分每几秒就变。
// 统一给 15 秒会让历史比赛每次访问都重新跨境拉 490KB，因此按比赛状态分档。
const CACHE_TTL_FINAL = 7 * 24 * 60 * 60 * 1000; // 已结束比赛的技术统计
const CACHE_TTL_LIVE = 8 * 1000; // 进行中
const CACHE_TTL_UPCOMING = 60 * 1000; // 未开始（只有赛程信息）
const CACHE_TTL_HISTORY = 6 * 60 * 60 * 1000; // 历史日期比分板 / 该日已全部结束
const CACHE_TTL_STATIC_DATA = 24 * 60 * 60 * 1000; // 球员搜索：名单几乎不变
const CACHE_TTL_GAMELOG = 5 * 60 * 1000; // 赛季逐场数据：每打完一场就变
const CACHE_TTL_DEFAULT = 10 * 1000;

const PROXY_CACHE_MAX = 600;
const PROXY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_DIR = path.join(DATA_DIR, 'proxy-cache');

// key -> { at, ttl, body, encoding, contentType }；Map 顺序即 LRU 顺序（末尾最新）
const proxyCache = new Map();
let proxyCacheBytes = 0;

function cacheFilePath(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha256').update(key).digest('hex') + '.json');
}

function proxyCacheGet(key) {
  const hit = proxyCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    proxyCacheDrop(key);
    return null;
  }
  // 命中即移到末尾，维持 LRU 顺序
  proxyCache.delete(key);
  proxyCache.set(key, hit);
  return hit;
}

function proxyCacheDrop(key) {
  const hit = proxyCache.get(key);
  if (!hit) return;
  proxyCache.delete(key);
  proxyCacheBytes -= hit.body.length;
  fs.unlink(cacheFilePath(key), () => {});
}

function proxyCachePrune() {
  while (
    proxyCache.size > PROXY_CACHE_MAX ||
    (proxyCacheBytes > PROXY_CACHE_MAX_BYTES && proxyCache.size > 1)
  ) {
    const oldest = proxyCache.keys().next().value;
    if (oldest === undefined) break;
    proxyCacheDrop(oldest);
  }
}

function proxyCacheSet(key, entry) {
  const existing = proxyCache.get(key);
  if (existing) {
    proxyCacheBytes -= existing.body.length;
    proxyCache.delete(key);
  }
  proxyCache.set(key, entry);
  proxyCacheBytes += entry.body.length;
  proxyCachePrune();

  // 落盘：进程重启或沙箱重建后历史比赛仍能直接命中，不必回源
  const payload = JSON.stringify({
    key,
    at: entry.at,
    ttl: entry.ttl,
    contentType: entry.contentType,
    encoding: entry.encoding,
    body: entry.body.toString('base64'),
  });
  const file = cacheFilePath(key);
  fs.mkdir(CACHE_DIR, { recursive: true }, () => {
    fs.writeFile(file, payload, () => {});
  });
}

/** 启动时把未过期的磁盘缓存读回内存 */
function loadProxyCacheFromDisk() {
  fs.mkdir(CACHE_DIR, { recursive: true }, () => {
    fs.readdir(CACHE_DIR, (error, files) => {
      if (error) return;
      const now = Date.now();
      let loaded = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(CACHE_DIR, file);
        try {
          const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (!item.key || !item.body || !item.ttl) continue;
          if (now - item.at > item.ttl) {
            fs.unlink(filePath, () => {});
            continue;
          }
          const body = Buffer.from(item.body, 'base64');
          proxyCache.set(item.key, {
            at: item.at,
            ttl: item.ttl,
            body,
            encoding: item.encoding || '',
            contentType: item.contentType,
          });
          proxyCacheBytes += body.length;
          loaded += 1;
        } catch {
          /* 单条损坏不影响启动 */
        }
      }
      proxyCachePrune();
      if (loaded) console.log(`[cache] 从磁盘恢复 ${loaded} 条 ESPN 缓存`);
    });
  });
}

/** 解压后解析，用于判断比赛状态；失败返回 null（退化为默认 TTL） */
function inspectJson(body, encoding) {
  try {
    let buffer = body;
    if (/gzip/i.test(encoding)) buffer = zlib.gunzipSync(body);
    else if (/deflate/i.test(encoding)) buffer = zlib.inflateSync(body);
    if (buffer.length > 8 * 1024 * 1024) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/** 美东日期 YYYYMMDD，用于判断 scoreboard 查的是不是历史日期 */
function etDateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return pick('year') + pick('month') + pick('day');
}

function scoreboardTTL(rest, json) {
  const events = json?.events || [];
  const matched = /[?&]dates=(\d{8})/.exec(rest);
  const dates = matched ? matched[1] : null;
  const today = etDateString();

  // 只有「显式查某个历史日期」才是真正不会再变的资源
  if (dates && dates < today) return CACHE_TTL_HISTORY;

  // 未来日期：只有赛程，变化慢
  if (dates && dates > today) return CACHE_TTL_UPCOMING;

  // 默认视图 / 今天：ESPN 默认视图可能返回昨天的板，今晚会换成新赛程，
  // 因此即使当前全部结束也只能短缓存，否则新比赛会被挡在缓存外。
  if (!events.length) return CACHE_TTL_DEFAULT;

  const settled = events.every(
    (event) => event?.competitions?.[0]?.status?.type?.state === 'post'
  );
  return settled ? CACHE_TTL_UPCOMING : CACHE_TTL_DEFAULT;
}

function decideCacheTTL(rest, body, encoding) {
  // gamelog 每打完一场就变，不能跟着名单类数据吃长缓存，
  // 否则新比赛要等一天才进赛季统计。
  if (/\/athletes\/[^/]+\/gamelog/.test(rest)) return CACHE_TTL_GAMELOG;

  // 球员搜索：名单几乎不变，可以长缓存
  if (/\/search\?/.test(rest)) return CACHE_TTL_STATIC_DATA;

  if (rest.startsWith('web/')) return CACHE_TTL_STATIC_DATA;

  const json = inspectJson(body, encoding);
  if (!json) return CACHE_TTL_DEFAULT;

  if (rest.startsWith('site/apis/site/v2/sports/basketball/nba/summary')) {
    const state = json?.header?.competitions?.[0]?.status?.type?.state;
    if (state === 'post') return CACHE_TTL_FINAL;
    if (state === 'in') return CACHE_TTL_LIVE;
    if (state === 'pre') return CACHE_TTL_UPCOMING;
    return CACHE_TTL_DEFAULT;
  }

  if (rest.startsWith('site/apis/site/v2/sports/basketball/nba/scoreboard')) {
    return scoreboardTTL(rest, json);
  }

  return CACHE_TTL_DEFAULT;
}

function acceptsGzip(request) {
  return /(^|,)\s*(gzip|deflate)\b/i.test(String(request?.headers?.['accept-encoding'] || ''));
}

function sendProxyPayload(response, status, contentType, encoding, body, cacheState, request, cachedAt, ttl) {
  if (response.headersSent) return;

  // 上游统一用 gzip 存，客户端不支持时才解压后再发
  let payload = body;
  let outEncoding = encoding;
  if (encoding && !acceptsGzip(request)) {
    try {
      payload = /gzip/i.test(encoding) ? zlib.gunzipSync(body) : zlib.inflateSync(body);
      outEncoding = '';
    } catch {
      /* 解压失败就原样返回 */
    }
  }

  const headers = {
    'Content-Type': contentType || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Proxy-Cache': cacheState,
  };
  if (outEncoding) {
    headers['Content-Encoding'] = outEncoding;
    headers.Vary = 'Accept-Encoding';
  }
  if (ttl) headers['X-Cache-TTL'] = String(Math.round(ttl / 1000));
  if (cachedAt) headers['X-Cache-Age'] = String(Math.round((Date.now() - cachedAt) / 1000));
  response.writeHead(status, headers);
  response.end(payload);
}

function handleEspnProxy(request, response, rest) {
  if (request.method !== 'GET') {
    response.writeHead(405);
    response.end('Method Not Allowed');
    return;
  }
  const match = rest.match(/^(site|web)(\/.*)?$/);
  if (!match) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  // 关键：始终向 ESPN 申请压缩体。summary 单场未压缩约 490KB，gzip 后仅约 46KB，
  // 在出口带宽受限的部署环境里能把 10 秒级耗时压到 1~2 秒。
  // 缓存只存压缩体，避免 gzip / 未压缩两份重复条目。
  const bypass = String(request.headers['x-force-refresh'] || '') === '1';
  const cacheKey = rest;

  if (!bypass) {
    const cached = proxyCacheGet(cacheKey);
    if (cached) {
      sendProxyPayload(
        response,
        200,
        cached.contentType,
        cached.encoding,
        cached.body,
        'hit',
        request,
        cached.at,
        cached.ttl
      );
      return;
    }
  }

  const proxyRequest = https.request(
    {
      hostname: ESPN_HOSTS[match[1]],
      path: match[2] || '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 25000,
    },
    (proxyResponse) => {
      const chunks = [];
      proxyResponse.on('data', (chunk) => chunks.push(chunk));
      proxyResponse.on('end', () => {
        const body = Buffer.concat(chunks);
        const status = proxyResponse.statusCode || 502;
        const encoding = String(proxyResponse.headers['content-encoding'] || '');
        const contentType = proxyResponse.headers['content-type'];
        const ttl = status === 200 ? decideCacheTTL(rest, body, encoding) : 0;
        if (ttl > 0) {
          proxyCacheSet(cacheKey, { at: Date.now(), ttl, body, encoding, contentType });
        }
        sendProxyPayload(
          response,
          status,
          contentType,
          encoding,
          body,
          bypass ? 'bypass' : 'miss',
          request,
          null,
          ttl
        );
      });
      proxyResponse.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('ESPN 接口读取失败');
        }
      });
    }
  );
  proxyRequest.on('timeout', () => {
    proxyRequest.destroy();
    if (!response.headersSent) {
      response.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ESPN 接口超时');
    }
  });
  proxyRequest.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ESPN 接口暂不可达');
    }
  });
  proxyRequest.end();
}

/* ---------- 正负值补查：按「比赛」维度批量取 +/- ---------- */

// 赛季逐场数据（gamelog）没有正负值字段，只有 summary 的 boxscore 里才有。
// 逐场逐人去查代价太大，这里按比赛维度批量取并落盘：
// 一场只拉一次、所有关注球员共享，终场后数据不再变化，可以直接复用。
const PLUSMINUS_DIR = path.join(DATA_DIR, 'plusminus');
const PLUSMINUS_MAX_EVENTS = 40; // 单次请求上限，防止被当成开放抓取口
const PLUSMINUS_CONCURRENCY = 4;
const PLUSMINUS_MAX_INFLIGHT = 6; // 全局同时向 ESPN 发起的抓取上限
const PLUSMINUS_TTL_LIVE = 2 * 60 * 1000; // 进行中的比赛正负值还会变

const plusMinusCache = new Map(); // eventId -> { at, state, players: { playerId: +/- } }
const plusMinusPending = new Map(); // eventId -> Promise，合并同一场的并发抓取

// 简单信号量：关注球员多时，多个请求会同时补查，需要压住对 ESPN 的并发
let plusMinusInflight = 0;
const plusMinusWaiters = [];

function acquirePlusMinusSlot() {
  if (plusMinusInflight < PLUSMINUS_MAX_INFLIGHT) {
    plusMinusInflight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => plusMinusWaiters.push(resolve));
}

function releasePlusMinusSlot() {
  const next = plusMinusWaiters.shift();
  if (next) next();
  else plusMinusInflight -= 1;
}

function plusMinusPath(eventId) {
  return path.join(PLUSMINUS_DIR, eventId + '.json');
}

function loadPlusMinusFromDisk() {
  try {
    if (!fs.existsSync(PLUSMINUS_DIR)) return;
    for (const name of fs.readdirSync(PLUSMINUS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const eventId = name.slice(0, -5);
      if (!/^\d+$/.test(eventId)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PLUSMINUS_DIR, name), 'utf8'));
        if (data && data.players) plusMinusCache.set(eventId, data);
      } catch {
        /* 单条损坏就跳过，不影响启动 */
      }
    }
  } catch {
    /* 目录不可读时当作空缓存 */
  }
}

function savePlusMinus(eventId, entry) {
  plusMinusCache.set(eventId, entry);
  // 只有终场数据值得落盘：它不会再变，下次启动直接复用
  if (entry.state !== 'post') return;
  fs.mkdir(PLUSMINUS_DIR, { recursive: true }, () => {
    fs.writeFile(plusMinusPath(eventId), JSON.stringify(entry), () => {});
  });
}

/** 拉一个 JSON 并解压；不复用 proxyCache，因为这里需要解析后的对象 */
function requestEspnJson(hostKey, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ESPN_HOSTS[hostKey],
        path: reqPath,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let body = raw;
          try {
            const encoding = String(res.headers['content-encoding'] || '');
            if (/gzip/i.test(encoding)) body = zlib.gunzipSync(raw);
            else if (/deflate/i.test(encoding)) body = zlib.inflateSync(raw);
          } catch {
            /* 解压失败就按原始体解析 */
          }
          if (res.statusCode !== 200) {
            reject(new Error('ESPN ' + res.statusCode));
            return;
          }
          try {
            resolve(JSON.parse(body.toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 从 summary 的 boxscore 里提取两队全部球员的正负值 */
function extractPlusMinus(summary) {
  const players = {};
  for (const team of summary?.boxscore?.players || []) {
    for (const stat of team.statistics || []) {
      const keys = stat.keys || [];
      const idx = keys.indexOf('plusMinus');
      if (idx < 0) continue;
      for (const entry of stat.athletes || []) {
        const id = entry?.athlete?.id;
        if (!id || !Array.isArray(entry.stats)) continue;
        const value = Number(entry.stats[idx]);
        if (Number.isFinite(value)) players[String(id)] = value;
      }
    }
  }
  return players;
}

async function resolvePlusMinus(eventId) {
  const cached = plusMinusCache.get(eventId);
  if (cached) {
    if (cached.state === 'post') return cached;
    if (Date.now() - cached.at < PLUSMINUS_TTL_LIVE) return cached;
  }

  // 同一场比赛会被多个球员、多个请求同时要，合并成一次抓取
  const pending = plusMinusPending.get(eventId);
  if (pending) return pending;

  const task = (async () => {
    await acquirePlusMinusSlot();
    try {
      // 排队期间可能已被别的请求填好，再查一次避免重复抓
      const again = plusMinusCache.get(eventId);
      if (again && (again.state === 'post' || Date.now() - again.at < PLUSMINUS_TTL_LIVE)) {
        return again;
      }
      const summary = await requestEspnJson(
        'site',
        '/apis/site/v2/sports/basketball/nba/summary?event=' + encodeURIComponent(eventId)
      );
      const entry = {
        at: Date.now(),
        state: summary?.header?.competitions?.[0]?.status?.type?.state || 'post',
        players: extractPlusMinus(summary),
      };
      savePlusMinus(eventId, entry);
      return entry;
    } catch {
      // 取不到就返回空表，前端按「无正负值」处理，不影响主流程
      return { at: Date.now(), state: 'error', players: {} };
    } finally {
      releasePlusMinusSlot();
    }
  })().finally(() => plusMinusPending.delete(eventId));

  plusMinusPending.set(eventId, task);
  return task;
}

async function handlePlusMinus(response, query) {
  const params = new URLSearchParams(query.startsWith('?') ? query : '?' + query);
  const ids = [
    ...new Set(
      String(params.get('events') || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => /^\d{6,12}$/.test(item))
    ),
  ];
  if (!ids.length) {
    sendJson(response, 400, { error: 'events 参数为空' });
    return;
  }
  if (ids.length > PLUSMINUS_MAX_EVENTS) {
    sendJson(response, 400, { error: `单次最多查询 ${PLUSMINUS_MAX_EVENTS} 场` });
    return;
  }

  const result = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PLUSMINUS_CONCURRENCY, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      const entry = await resolvePlusMinus(id);
      result[id] = entry.players;
    }
  });
  await Promise.all(workers);
  sendJson(response, 200, result);
}

ensureStore();
loadProxyCacheFromDisk();
loadPlusMinusFromDisk();

http
  .createServer(async (request, response) => {
    const url = request.url || '/';
    const queryIndex = url.indexOf('?');
    const rawPath = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : url.slice(queryIndex);
    const pathname = decodeURIComponent(rawPath);

    // 网关剥离 Authorization 时，允许用 ?token= 传递会话令牌
    const tokenParam = new URLSearchParams(query).get('token');
    if (tokenParam && /^[A-Za-z0-9]{64}$/.test(tokenParam)) {
      request.headers.authorization = 'Bearer ' + tokenParam;
    }

    try {
      if (pathname === '/api/plusminus') {
        await handlePlusMinus(response, query);
        return;
      }
      if (pathname.startsWith('/api/espn/')) {
        handleEspnProxy(request, response, pathname.slice('/api/espn/'.length) + query);
        return;
      }
      if (pathname.startsWith('/api/')) {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        await handleApi(request, response, pathname);
        return;
      }
      serveStatic(pathname, request, response);
    } catch (error) {
      const status = error.statusCode || 500;
      if (!response.headersSent) {
        sendJson(response, status, { error: error.message || '服务器内部错误' });
      } else {
        response.end();
      }
    }
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`NBA 看台已启动: http://localhost:${PORT}`);
  });

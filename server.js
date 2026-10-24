'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function serveStatic(pathname, response) {
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
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
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

// 代理层短缓存：同一场比赛/同一次搜索在 15 秒内复用，避免多端与自动刷新重复回溯
const PROXY_CACHE_TTL_MS = 15000;
const PROXY_CACHE_MAX = 400;
const proxyCache = new Map();

function proxyCacheGet(key) {
  const hit = proxyCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PROXY_CACHE_TTL_MS) {
    proxyCache.delete(key);
    return null;
  }
  return hit;
}

function proxyCacheSet(key, value) {
  if (proxyCache.size >= PROXY_CACHE_MAX) {
    const oldest = proxyCache.keys().next().value;
    if (oldest !== undefined) proxyCache.delete(oldest);
  }
  proxyCache.set(key, value);
}

function sendProxyPayload(response, status, contentType, encoding, body, cacheState) {
  if (response.headersSent) return;
  const headers = {
    'Content-Type': contentType || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Proxy-Cache': cacheState,
  };
  if (encoding) {
    headers['Content-Encoding'] = encoding;
    headers.Vary = 'Accept-Encoding';
  }
  response.writeHead(status, headers);
  response.end(body);
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

  // 关键：向 ESPN 请求压缩体。summary 单场未压缩约 490KB，gzip 后仅约 46KB，
  // 在出口带宽受限的部署环境里能把 10 秒级耗时压到 1~2 秒，避免前端 15 秒超时。
  const clientAcceptsGzip = /(^|,)\s*gzip\b/i.test(String(request.headers['accept-encoding'] || ''));
  const cacheKey = (clientAcceptsGzip ? 'gzip:' : 'raw:') + rest;

  const cached = proxyCacheGet(cacheKey);
  if (cached) {
    sendProxyPayload(response, 200, cached.contentType, cached.encoding, cached.body, 'hit');
    return;
  }

  const proxyRequest = https.request(
    {
      hostname: ESPN_HOSTS[match[1]],
      path: match[2] || '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        ...(clientAcceptsGzip ? { 'Accept-Encoding': 'gzip, deflate' } : {}),
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
        if (status === 200) {
          proxyCacheSet(cacheKey, { at: Date.now(), body, encoding, contentType });
        }
        sendProxyPayload(response, status, contentType, encoding, body, 'miss');
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

ensureStore();

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
      serveStatic(pathname, response);
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

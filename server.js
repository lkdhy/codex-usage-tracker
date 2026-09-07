const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'snapshots.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ACCOUNT_DATA_DIR = path.join(DATA_DIR, 'accounts');
const MAX_SNAPSHOTS_PER_ACCOUNT = 20000;
const MAX_BODY_BYTES = 1024 * 1024;
const ADMIN_PASSWORD = process.env.CODEX_ADMIN_PASSWORD || '';
const adminSessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ACCOUNT_DATA_DIR, { recursive: true });

const defaultConfig = { enabled: true, intervalMinutes: 5, timeoutSeconds: 10 };
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function requestError(message, statusCode = 502, code = 'UPSTREAM_ERROR') {
  return Object.assign(new Error(message), { statusCode, code });
}
function newId() { return crypto.randomUUID(); }
function credentialPath(account) { return path.join(ACCOUNT_DATA_DIR, `${account.id}.json`); }
function tokenFromCredentials(value) { return value?.access_token || value?.tokens?.access_token; }
function parseCredentials(input) {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { throw new Error('auth.json 内容不是有效 JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !tokenFromCredentials(value)) {
    throw new Error('auth.json JSON 中没有找到 access_token');
  }
  return value;
}
function saveCredentials(account, input) {
  const value = parseCredentials(input);
  const file = credentialPath(account);
  writeJson(file, value);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs may ignore chmod. */ }
}
function ensureCredentialFile(account) {
  const file = credentialPath(account);
  if (fs.existsSync(file)) return;
  writeJson(file, {});
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs may ignore chmod. */ }
}
function credentialsReady(account) {
  return !!tokenFromCredentials(readJson(credentialPath(account), null));
}

let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
config.intervalMinutes = Math.max(1, Math.min(1440, Number(config.intervalMinutes) || 5));
let accounts = Array.isArray(readJson(ACCOUNTS_FILE, null)) ? readJson(ACCOUNTS_FILE, []) : [];
let snapshots = Array.isArray(readJson(DATA_FILE, [])) ? readJson(DATA_FILE, []) : [];
let pollTimer;
const activePolls = new Set();

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  const entry = cookies.find(item => item.trim().startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : '';
}
function isAdmin(req) {
  const token = cookieValue(req, 'codex_admin');
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) { adminSessions.delete(token); return false; }
  return true;
}
function requireAdmin(req) {
  if (!ADMIN_PASSWORD) throw requestError('尚未配置管理员密码，请设置 CODEX_ADMIN_PASSWORD 后重启服务', 503, 'ADMIN_PASSWORD_NOT_CONFIGURED');
  if (!isAdmin(req)) throw requestError('需要管理员登录', 403, 'ADMIN_REQUIRED');
}
function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function migrateLegacyData() {
  let changed = false;
  if (!accounts.length && snapshots.length) {
    const id = newId();
    const first = snapshots.find(x => x.raw?.account_id || x.accountId);
    accounts = [{
      id,
      name: '默认账号',
      enabled: true,
      remoteAccountId: first?.raw?.account_id || null,
      email: first?.raw?.email || null,
      createdAt: new Date().toISOString(),
      lastPolledAt: snapshots.at(-1)?.capturedAt || null,
      lastError: null
    }];
    snapshots = snapshots.map(item => ({ ...item, accountId: item.accountId || id }));
    changed = true;
  }
  if (accounts.length) {
    accounts = accounts.map(account => ({
      id: account.id || newId(),
      name: account.name || '未命名账号',
      enabled: account.enabled !== false,
      remoteAccountId: account.remoteAccountId || null,
      email: account.email || null,
      createdAt: account.createdAt || new Date().toISOString(),
      lastPolledAt: account.lastPolledAt || null,
      lastError: account.lastError || null,
      lastErrorCode: account.lastErrorCode || null
    }));
    changed = true;
  }
  if (changed) {
    accounts.forEach(ensureCredentialFile);
    writeJson(ACCOUNTS_FILE, accounts);
    writeJson(DATA_FILE, snapshots);
  }
}
migrateLegacyData();

function splitMixedLegacySnapshots() {
  if (accounts.length !== 1 || snapshots.length === 0) return;
  const original = accounts[0];
  const groups = new Map();
  for (const item of snapshots) {
    const remoteId = item.remoteAccountId || item.raw?.account_id;
    if (!remoteId) continue;
    if (!groups.has(remoteId)) groups.set(remoteId, []);
    groups.get(remoteId).push(item);
  }
  if (groups.size <= 1) return;
  const ordered = [...groups.entries()].sort((a, b) => new Date(a[1].at(-1).capturedAt) - new Date(b[1].at(-1).capturedAt));
  const currentRemoteId = ordered.at(-1)[0];
  const idByRemote = new Map();
  const splitAccounts = ordered.map(([remoteId, items], index) => {
    const isCurrent = remoteId === currentRemoteId;
    const account = {
      ...original,
      id: isCurrent ? original.id : newId(),
      name: isCurrent ? `${original.name}（当前）` : `${original.name}（历史）`,
      remoteAccountId: remoteId,
      email: items.at(-1).email || items.at(-1).raw?.email || null,
      enabled: isCurrent,
      lastPolledAt: items.at(-1).capturedAt,
      lastError: null
    };
    idByRemote.set(remoteId, account.id);
    return account;
  });
  snapshots = snapshots.map(item => ({ ...item, accountId: idByRemote.get(item.remoteAccountId || item.raw?.account_id) || original.id }));
  accounts = splitAccounts;
  accounts.forEach(ensureCredentialFile);
  writeJson(ACCOUNTS_FILE, accounts);
  writeJson(DATA_FILE, snapshots);
}
splitMixedLegacySnapshots();

function readAuth(account) {
  const value = readJson(credentialPath(account), {});
  const token = tokenFromCredentials(value);
  const authAccount = value.account_id || (value.tokens && value.tokens.account_id);
  return { token, account: authAccount };
}

function normalizeWindow(x) {
  if (!x) return null;
  const used = x.used_percent ?? x.usedPercent;
  if (typeof x !== 'object' || used === null || used === undefined ||
      !['number', 'string'].includes(typeof used) || String(used).trim() === '' ||
      !Number.isFinite(Number(used)) || Number(used) < 0 || Number(used) > 100) {
    throw requestError('用量接口字段不兼容：缺少有效的 used_percent，未保存本次快照', 502, 'UPSTREAM_SCHEMA');
  }
  return {
    usedPercent: Number(used),
    limitWindowSeconds: Number(x.limit_window_seconds ?? x.windowDurationSecs ?? 0),
    resetAfterSeconds: Number(x.reset_after_seconds ?? 0),
    resetAt: Number(x.reset_at ?? x.resetsAt ?? 0)
  };
}

function normalize(raw, account) {
  const rl = raw?.rate_limit ?? raw?.rateLimit;
  if (!rl || typeof rl !== 'object' || !(rl.primary_window || rl.primary || rl.secondary_window || rl.secondary)) {
    throw requestError('用量接口响应结构已变化：缺少用量窗口，未保存本次快照', 502, 'UPSTREAM_SCHEMA');
  }
  return {
    accountId: account.id,
    capturedAt: new Date().toISOString(),
    planType: raw.plan_type || 'unknown',
    remoteAccountId: raw.account_id || null,
    email: raw.email || null,
    allowed: rl.allowed !== false,
    limitReached: !!rl.limit_reached,
    primary: normalizeWindow(rl.primary_window || rl.primary),
    secondary: normalizeWindow(rl.secondary_window || rl.secondary),
    credits: raw.credits || null,
    raw
  };
}

function publicSnapshot(item) {
  const { raw, ...safe } = item;
  return safe;
}

function accountById(id) { return accounts.find(account => account.id === id); }

function accountSummary(account) {
  const history = snapshots.filter(item => item.accountId === account.id);
  const latest = history.at(-1) || null;
  return {
    ...account,
    credentialsReady: credentialsReady(account),
    latest: latest ? publicSnapshot(latest) : null,
    snapshotCount: history.length
  };
}

function saveAccounts() { writeJson(ACCOUNTS_FILE, accounts); }
function saveSnapshots() {
  const counts = new Map();
  snapshots = snapshots.slice().reverse().filter(item => {
    const count = (counts.get(item.accountId) || 0) + 1;
    counts.set(item.accountId, count);
    return count <= MAX_SNAPSHOTS_PER_ACCOUNT;
  }).reverse();
  writeJson(DATA_FILE, snapshots);
}

async function pollAccount(id) {
  const account = accountById(id);
  if (!account) throw new Error('账号不存在');
  if (activePolls.has(id)) throw new Error('该账号正在查询，请稍候');
  const auth = readAuth(account);
  if (!auth.token) {
    account.lastError = null;
    account.lastErrorCode = null;
    saveAccounts();
    throw requestError('尚未设置有效凭据，请在编辑账号中粘贴 auth.json 的 JSON 内容', 400, 'CREDENTIALS_MISSING');
  }
  activePolls.add(id);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, config.timeoutSeconds) * 1000);
    try {
      const headers = {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'User-Agent': 'codex-usage-tracker/2.0'
      };
      if (auth.account) headers['ChatGPT-Account-ID'] = auth.account;
      let response;
      try {
        response = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers, signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw requestError('无法连接用量接口，请检查网络后重试', 502, 'UPSTREAM_NETWORK');
      }
      if (!response.ok) {
        const errors = {
          401: ['登录凭据已失效，请编辑账号并粘贴新的 auth.json', 'AUTH_EXPIRED'],
          403: ['用量接口拒绝访问，请检查账号权限或稍后重试', 'UPSTREAM_FORBIDDEN'],
          404: ['用量接口不存在，接口地址可能已变化，需要更新程序', 'UPSTREAM_ENDPOINT'],
          429: ['用量接口请求过于频繁，请延长查询间隔后重试', 'UPSTREAM_RATE_LIMIT']
        };
        const [message, code] = errors[response.status] || [
          response.status >= 500 ? '用量服务暂时不可用，请稍后重试' : '用量接口返回异常状态', 'UPSTREAM_HTTP'
        ];
        await response.body?.cancel();
        throw requestError(`${message}（HTTP ${response.status}）`, 502, code);
      }
      let body;
      try { body = await response.text(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        throw requestError('读取用量接口响应失败，请检查网络后重试', 502, 'UPSTREAM_NETWORK');
      }
      let raw;
      try { raw = JSON.parse(body); }
      catch { throw requestError('用量接口返回的不是有效 JSON，可能为登录页或接口已变化', 502, 'UPSTREAM_FORMAT'); }
      const item = normalize(raw, account);
      const remoteAccountId = raw.account_id || auth.account || null;
      if (account.remoteAccountId && remoteAccountId && account.remoteAccountId !== remoteAccountId) {
        throw new Error(`凭据对应的账号已变化（原账号 ${account.remoteAccountId.slice(0, 8)}…，现为 ${remoteAccountId.slice(0, 8)}…），为避免混入历史数据，本次未保存。`);
      }
      if (!account.remoteAccountId && remoteAccountId) account.remoteAccountId = remoteAccountId;
      if (raw.email) account.email = raw.email;
      snapshots.push(item);
      account.lastPolledAt = item.capturedAt;
      account.lastError = null;
      account.lastErrorCode = null;
      saveAccounts();
      saveSnapshots();
      return item;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error.name === 'AbortError') error = requestError('请求超时，请稍后重试', 504, 'UPSTREAM_TIMEOUT');
    account.lastError = error.message;
    account.lastErrorCode = error.code || 'POLL_FAILED';
    saveAccounts();
    throw error;
  } finally {
    activePolls.delete(id);
  }
}

async function pollAll() {
  const results = [];
  for (const account of accounts.filter(item => item.enabled)) {
    if (!credentialsReady(account)) {
      if (account.lastError || account.lastErrorCode) {
        account.lastError = null;
        account.lastErrorCode = null;
        saveAccounts();
      }
      results.push({ accountId: account.id, skipped: true, reason: 'CREDENTIALS_MISSING' });
      continue;
    }
    try { results.push({ accountId: account.id, snapshot: await pollAccount(account.id) }); }
    catch (error) { results.push({ accountId: account.id, error: error.message }); }
  }
  return results;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let failed = false;
    function fail(error) {
      failed = true;
      chunks = [];
      reject(error);
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume();
      fail(requestError('请求内容不能超过 1 MiB', 413, 'BODY_TOO_LARGE'));
      return;
    }
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(requestError('请求内容不能超过 1 MiB', 413, 'BODY_TOO_LARGE'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const value = body ? JSON.parse(body) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { fail(requestError('请求内容必须是有效 JSON 对象', 400, 'INVALID_JSON')); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(requestError('请求已中断', 400, 'REQUEST_ABORTED')));
  });
}

function serve(req, res, pathname) {
  const allowedFiles = new Set(['/', '/index.html', '/app.js', '/styles.css']);
  if (!allowedFiles.has(pathname)) return json(res, 404, { error: 'not found' });
  const relative = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(relative).replace(/^([.][.][\\/])+/, '');
  const target = path.join(ROOT, safe);
  if (!target.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(target, (error, data) => {
    if (error) return json(res, 404, { error: 'not found' });
    const ext = path.extname(target);
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function schedule() {
  clearInterval(pollTimer);
  if (config.enabled) pollTimer = setInterval(() => pollAll().catch(() => {}), config.intervalMinutes * 60000);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { admin: isAdmin(req), configured: !!ADMIN_PASSWORD });
    if (req.method === 'POST' && pathname === '/api/login') {
      const input = await bodyJson(req);
      if (!ADMIN_PASSWORD || !safeEqualText(input.password || '', ADMIN_PASSWORD)) return json(res, 401, { error: '密码错误' });
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `codex_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      return res.end(JSON.stringify({ admin: true }));
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      adminSessions.delete(cookieValue(req, 'codex_admin'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'codex_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return res.end(JSON.stringify({ admin: false }));
    }
    if (req.method === 'GET' && (pathname === '/api/state' || pathname === '/api/history')) {
      const accountId = url.searchParams.get('accountId');
      const filtered = accountId ? snapshots.filter(item => item.accountId === accountId) : snapshots;
      return json(res, 200, { accounts: accounts.map(accountSummary), snapshots: filtered.map(publicSnapshot), config });
    }
    if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, config);
    if (req.method === 'GET' && pathname === '/api/accounts') return json(res, 200, accounts.map(accountSummary));

    if (req.method === 'POST' && pathname === '/api/accounts') {
      requireAdmin(req);
      const input = await bodyJson(req);
      const name = String(input.name || '').trim();
      if (!name) return json(res, 400, { error: '账号名称不能为空' });
      if (input.credentials === undefined || input.credentials === '') return json(res, 400, { error: '请粘贴 auth.json 的 JSON 内容' });
      const account = { id: newId(), name: name.slice(0, 80), enabled: input.enabled !== false, remoteAccountId: null, email: null, createdAt: new Date().toISOString(), lastPolledAt: null, lastError: null };
      try { saveCredentials(account, input.credentials); } catch (error) { return json(res, 400, { error: error.message }); }
      accounts.push(account);
      saveAccounts();
      return json(res, 201, accountSummary(account));
    }

    const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
    const pollMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/poll$/);
    if (req.method === 'POST' && pollMatch) {
      const snapshot = await pollAccount(decodeURIComponent(pollMatch[1]));
      return json(res, 200, { snapshot: publicSnapshot(snapshot) });
    }
    if (accountMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
      requireAdmin(req);
      const account = accountById(decodeURIComponent(accountMatch[1]));
      if (!account) return json(res, 404, { error: '账号不存在' });
      const input = await bodyJson(req);
      if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name) return json(res, 400, { error: '账号名称不能为空' });
        account.name = name.slice(0, 80);
      }
      if (input.credentials !== undefined && input.credentials.trim?.()) {
        try { saveCredentials(account, input.credentials); } catch (error) { return json(res, 400, { error: error.message }); }
        account.remoteAccountId = null;
        account.email = null;
        account.lastError = null;
        account.lastErrorCode = null;
      }
      if (input.enabled !== undefined) account.enabled = input.enabled !== false;
      saveAccounts();
      return json(res, 200, accountSummary(account));
    }
    if (req.method === 'DELETE' && accountMatch) {
      requireAdmin(req);
      const id = decodeURIComponent(accountMatch[1]);
      const account = accountById(id);
      if (!account) return json(res, 404, { error: '账号不存在' });
      accounts = accounts.filter(account => account.id !== id);
      snapshots = snapshots.filter(item => item.accountId !== id);
      try { fs.rmSync(credentialPath(account), { force: true }); } catch { /* Keep account deletion successful if the file is already absent. */ }
      saveAccounts();
      saveSnapshots();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/poll') return json(res, 200, { results: await pollAll() });
    if (req.method === 'POST' && pathname === '/api/config') {
      requireAdmin(req);
      const input = await bodyJson(req);
      config = { ...config, ...input };
      config.enabled = config.enabled !== false;
      config.intervalMinutes = Math.max(1, Math.min(1440, Number(config.intervalMinutes) || 5));
      config.timeoutSeconds = Math.max(1, Math.min(120, Number(config.timeoutSeconds) || 10));
      writeJson(CONFIG_FILE, config);
      schedule();
      return json(res, 200, config);
    }
    return serve(req, res, pathname);
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message || '服务器错误', code: error.code || 'INTERNAL_ERROR' });
  }
});

server.listen(4782, '127.0.0.1', () => {
  schedule();
  console.log('Codex Usage Tracker: http://127.0.0.1:4782');
  pollAll().then(results => {
    const failed = results.filter(item => item.error);
    if (failed.length) console.warn('Initial poll:', failed.map(item => item.error).join('; '));
  }).catch(error => console.warn('Initial poll:', error.message));
});

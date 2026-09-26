const $ = selector => document.querySelector(selector);

const DAY = 864e5;
const VIEW_KEY = 'codex-usage-view';
const RANGES = ['1', '7', '30', 'all'];
const TICK_STEPS = [10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 20160, 43200].map(minutes => minutes * 60000);
const PLAN_NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const WEEKDAYS = '日一二三四五六';

let state = { accounts: [], snapshots: [], config: {}, session: { admin: false, configured: true } };
let connection = { online: null, syncedAt: 0, error: '' };
let view = loadView();
let series = [];
let chartModel = null;
let hoverTime = null;
let loadSequence = 0;
let refreshingAll = false;
const busy = new Set();
const signatures = { data: '', cards: '', chart: '' };

function loadView() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch { /* 无法读取时使用默认视图 */ }
  return {
    range: RANGES.includes(saved.range) ? saved.range : '1',
    scale: saved.scale === 'full' ? 'full' : 'adaptive',
    hidden: Array.isArray(saved.hidden) ? saved.hidden.map(String) : [],
    table: saved.table === true
  };
}
function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* 隐私模式等场景下无法保存，忽略即可 */ }
}

// ---------- 格式化 ----------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
const pad = value => String(value).padStart(2, '0');
const clock = time => { const date = new Date(time); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const fullTime = time => new Date(time).toLocaleString('zh-CN', { hour12: false });
const percent = value => `${Math.round(value * 10) / 10}%`;
function dayLabel(time) {
  const date = new Date(time);
  const diff = Math.round((new Date(time).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`;
}
const dateTime = time => `${dayLabel(time)} ${clock(time)}`;
function formatAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}
function formatSpan(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  return hours % 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours / 24} 天`;
}

// ---------- 账号状态 ----------
function windowName(seconds, short = false) {
  const hours = Math.round(Number(seconds) / 3600);
  if (!hours) return short ? '窗口' : '用量窗口';
  const text = hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
  return short ? text : `${text}窗口`;
}
// 重置时间优先用绝对时间 resetAt；缺少时退回“采样时间 + 剩余秒数”，不能直接显示采样当时的剩余秒数。
function describeWindow(win, capturedAt, now) {
  if (!win || !Number.isFinite(Number(win.usedPercent))) return null;
  const resetsAt = Number(win.resetAt) > 0 ? Number(win.resetAt) * 1000
    : Number(win.resetAfterSeconds) > 0 ? capturedAt + Number(win.resetAfterSeconds) * 1000 : null;
  return {
    name: windowName(win.limitWindowSeconds),
    short: windowName(win.limitWindowSeconds, true),
    used: Math.max(0, Math.min(100, Number(win.usedPercent))),
    resetsAt,
    reset: resetsAt !== null && resetsAt <= now
  };
}
const usageLevel = win => win.reset ? 'reset' : win.used >= 90 ? 'danger' : win.used >= 70 ? 'warning' : 'normal';
const staleAfter = () => Math.max(30, 3 * (Number(state.config.intervalMinutes) || 5)) * 60000;
const seriesColor = index => index < 8 ? `var(--series-${index + 1})` : 'var(--series-other)';
const accountOf = id => state.accounts.find(account => account.id === id);

function describeAccount(account, index, now) {
  const latest = account.latest || null;
  const capturedAt = latest ? Date.parse(latest.capturedAt) : null;
  const windows = latest ? [latest.primary, latest.secondary].map(win => describeWindow(win, capturedAt, now)).filter(Boolean) : [];
  const extras = latest ? (latest.additional || []).map(item => ({
    name: String(item.name || '附加额度'),
    windows: [item.primary, item.secondary].map(win => describeWindow(win, capturedAt, now)).filter(Boolean)
  })).filter(item => item.windows.length) : [];
  const expiresAt = account.credentialsExpiresAt ? Date.parse(account.credentialsExpiresAt) : null;
  // 剩余额度取决于已用比例最高（最受限）且尚未重置的窗口，例如 5 小时窗口用了 90% 时只剩 10%。
  const binding = windows.filter(win => !win.reset).sort((a, b) => b.used - a.used)[0] || null;
  // 接口的已用比例是整数，显示 100% 时 limit_reached 可能仍为 false；两者任一成立都视为额度受限。
  // 所有窗口都已重置时，上次记录的受限状态已不再成立。
  const exhausted = !!binding && binding.used >= 100;
  const flagged = !!latest && (latest.limitReached || latest.allowed === false) && !(windows.length && windows.every(win => win.reset));
  const limited = exhausted || flagged;
  const blocking = windows.filter(win => !win.reset && win.used >= 100 && win.resetsAt);
  const upcoming = windows.filter(win => !win.reset && win.resetsAt);
  const recoverAt = !limited ? null
    : blocking.length ? Math.max(...blocking.map(win => win.resetsAt))
      : upcoming.length ? Math.min(...upcoming.map(win => win.resetsAt)) : null;
  const model = {
    account, index, latest, capturedAt, windows, extras, expiresAt, limited, exhausted, flagged, recoverAt, binding,
    remaining: binding ? 100 - binding.used : windows.length ? 100 : null,
    primary: windows[0] || null,
    credentialsExpired: expiresAt !== null && expiresAt <= now,
    stale: !!latest && (now - capturedAt > staleAfter() || windows.some(win => win.reset))
  };
  model.status = statusOf(model);
  return model;
}

function statusOf(model) {
  const { account } = model;
  if (!account.enabled) return { key: 'paused', icon: '‖', text: '已暂停' };
  if (!account.credentialsReady) return { key: 'pending', icon: '…', text: '待设置凭据' };
  if (account.lastErrorCode === 'AUTH_EXPIRED' || model.credentialsExpired) return { key: 'critical', icon: '!', text: '凭据已失效' };
  if (account.lastError) return { key: 'critical', icon: '!', text: '查询失败' };
  if (!model.latest) return { key: 'pending', icon: '…', text: '待查询' };
  if (model.limited) return { key: 'warning', icon: '!', text: model.exhausted ? '额度已用完' : '已达限制' };
  if (model.stale) return { key: 'stale', icon: '↻', text: '待刷新' };
  return { key: 'good', icon: '✓', text: '可用' };
}

// ---------- 页面渲染 ----------
function renderAdmin() {
  const admin = !!state.session.admin;
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !admin; });
  $('#adminLogin').hidden = admin;
  $('#adminLogout').hidden = !admin;
}

function renderStatus() {
  const text = $('#statusText');
  $('#connectionDot').className = `dot${connection.online === true ? ' is-online' : connection.online === false ? ' is-offline' : ''}`;
  if (connection.online === null) text.textContent = '正在读取…';
  else if (!connection.online) text.textContent = connection.syncedAt ? `无法连接服务，显示的是 ${clock(connection.syncedAt)} 的数据` : `无法连接服务：${connection.error}`;
  else text.textContent = `${state.config.enabled === false ? '自动查询已关闭' : `自动查询每 ${state.config.intervalMinutes || 5} 分钟一次`} · 页面同步于 ${clock(connection.syncedAt)}`;
}

const tile = (label, value, note, tone = '') =>
  `<article class="tile${tone ? ` tone-${tone}` : ''}"><span class="tile-label">${label}</span><strong class="tile-value">${value}</strong><span class="tile-note">${note}</span></article>`;
const until = time => `<time data-until="${time}">${formatSpan(time - Date.now())}</time>`;
const resetText = win => win.reset ? `已于 ${dateTime(win.resetsAt)} 重置` : win.resetsAt ? `${until(win.resetsAt)}后重置` : '重置时间未知';

function renderSummary(models) {
  const enabled = models.filter(model => model.account.enabled);
  const usable = enabled.filter(model => model.status.key === 'good' || model.status.key === 'stale');
  const staleCount = usable.filter(model => model.status.key === 'stale').length;
  const paused = models.length - enabled.length;
  const most = usable.filter(model => model.remaining !== null).sort((a, b) => b.remaining - a.remaining)[0];
  const next = enabled.filter(model => model.status.key === 'warning' && model.recoverAt).sort((a, b) => a.recoverAt - b.recoverAt)[0];
  const attention = enabled.filter(model => model.status.key === 'critical' || !model.account.credentialsReady);
  const name = model => escapeHtml(model.account.name);
  $('#summary').innerHTML = [
    tile('可用账号', models.length ? `${usable.length} / ${models.length}` : '—',
      !models.length ? '还没有账号' : [paused && `${paused} 个已暂停`, staleCount && `${staleCount} 个数据待刷新`].filter(Boolean).join(' · ') || '启用的账号均可使用'),
    tile('剩余额度最多', most ? (most.binding ? `${most.remaining}%` : '已重置') : '—',
      most ? `${name(most)} · ${most.binding ? `${most.binding.name}已用 ${most.binding.used}%` : '窗口已重置，等待下次查询'}` : '暂无可用账号'),
    tile('最早恢复额度', next ? `${until(next.recoverAt)}后` : '—',
      next ? `${name(next)} · ${dateTime(next.recoverAt)}` : '没有额度用完或受限的账号'),
    tile('需要处理', String(attention.length),
      attention.length ? attention.slice(0, 2).map(model => `${name(model)}：${model.account.credentialsReady ? model.status.text : '待设置凭据'}`).join('；') + (attention.length > 2 ? ' 等' : '') : '没有待处理的问题',
      attention.length ? 'critical' : '')
  ].join('');
}

function renderAccounts(models) {
  const container = $('#accounts');
  $('#accountsNote').textContent = models.length ? `共 ${models.length} 个，每个账号使用独立的凭据和历史` : '';
  if (!models.length) {
    container.innerHTML = state.session.admin
      ? '<div class="empty-state"><h3>还没有账号</h3><p>添加账号并粘贴对应的 auth.json，就可以开始记录用量。</p><button type="button" class="button primary" data-action="add">添加第一个账号</button></div>'
      : '<div class="empty-state"><h3>还没有账号</h3><p>请管理员登录后添加账号。</p></div>';
    return;
  }
  container.innerHTML = models.map(cardHtml).join('');
}

function cardHtml(model) {
  const { account, status, latest } = model;
  const admin = !!state.session.admin;
  const polling = busy.has(account.id) || (refreshingAll && account.enabled && account.credentialsReady);
  const plan = latest?.planType && latest.planType !== 'unknown' ? PLAN_NAMES[latest.planType] || latest.planType : '';
  const blocked = !account.enabled ? '该账号已暂停查询' : !account.credentialsReady ? '尚未设置凭据' : '';
  const actions = [
    `<button type="button" class="button small" data-action="poll"${blocked || polling ? ' disabled' : ''}${blocked ? ` title="${blocked}"` : ''}>${polling ? '查询中…' : '查询'}</button>`,
    admin && `<button type="button" class="button small ghost" data-action="toggle">${account.enabled ? '暂停' : '恢复'}</button>`,
    admin && '<button type="button" class="button small ghost" data-action="edit">编辑</button>',
    admin && '<button type="button" class="button small ghost danger" data-action="delete">删除</button>'
  ].filter(Boolean).join('');
  return `<article class="card status-${status.key}${polling ? ' is-busy' : ''}" data-account-id="${escapeHtml(account.id)}">
    <header class="card-head">
      <span class="swatch" style="background:${seriesColor(model.index)}" aria-hidden="true"></span>
      <h3 title="${escapeHtml(account.name)}">${escapeHtml(account.name)}</h3>
      ${plan ? `<span class="badge">${escapeHtml(plan)}</span>` : ''}
      <span class="pill pill-${status.key}"><span class="pill-icon" aria-hidden="true">${status.icon}</span>${status.text}</span>
    </header>
    <div class="card-meta"><span class="email" title="${escapeHtml(account.email || '')}">${escapeHtml(account.email || '尚未识别邮箱')}</span>${credentialHtml(model)}</div>
    ${windowsHtml(model)}
    ${extrasHtml(model)}
    ${noticeHtml(model)}
    <footer class="card-foot">
      <span class="updated${model.stale ? ' is-stale' : ''}">${latest ? `更新于 <time data-ago="${model.capturedAt}" title="${fullTime(model.capturedAt)}">${formatAgo(Date.now() - model.capturedAt)}</time>` : '还没有快照'} · ${account.snapshotCount || 0} 条记录</span>
      <div class="card-actions">${actions}</div>
    </footer>
  </article>`;
}

function credentialHtml({ account, expiresAt }) {
  if (!account.credentialsReady) return '<span class="cred is-bad"><i aria-hidden="true">!</i>尚未设置凭据</span>';
  if (expiresAt === null) return '<span class="cred">凭据已设置</span>';
  const left = expiresAt - Date.now();
  if (left <= 0) return `<span class="cred is-bad" title="${fullTime(expiresAt)}"><i aria-hidden="true">!</i>凭据已于 ${dateTime(expiresAt)} 过期</span>`;
  return `<span class="cred${left < 2 * DAY ? ' is-warn' : ''}" title="到期时间 ${fullTime(expiresAt)}">${left < 2 * DAY ? '<i aria-hidden="true">!</i>' : ''}<span>凭据 ${until(expiresAt)}后过期</span></span>`;
}

function windowsHtml(model) {
  if (!model.latest) return '<p class="windows-empty">完成首次查询后显示用量</p>';
  if (!model.windows.length) return '<p class="windows-empty">上次查询没有返回用量窗口</p>';
  return `<div class="windows">${model.windows.map((win, index) => `<div class="window${index === 0 ? ' is-main' : ''} level-${usageLevel(win)}">
    <div class="window-top"><span class="window-name">${win.name}</span><span class="window-reset"${win.resetsAt ? ` title="${fullTime(win.resetsAt)}"` : ''}>${resetText(win)}</span></div>
    <div class="window-value">${win.reset
      ? `已重置<span class="window-sub">重置前已用 ${win.used}%</span>`
      : `${win.used}<small>%</small><span class="window-sub">已用 · 剩余 ${100 - win.used}%</span>`}</div>
    <div class="meter" role="meter" aria-label="${win.name}已用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${win.reset ? 0 : win.used}"><span style="width:${win.reset ? 0 : win.used}%"></span></div>
  </div>`).join('')}</div>`;
}

function extrasHtml(model) {
  if (!model.extras.length) return '';
  return `<div class="extras"><span class="extras-title">附加额度</span>${model.extras.map(extra => `<div class="extra">
    <span class="extra-name" title="${escapeHtml(extra.name)}">${escapeHtml(extra.name)}</span>
    <span class="extra-windows">${extra.windows.map(win => `<span class="extra-window level-${usageLevel(win)}" title="${win.name}${win.reset ? '' : `已用 ${win.used}%`}${win.resetsAt ? `，${win.reset ? '已于' : '将于'} ${dateTime(win.resetsAt)} 重置` : ''}">${win.short}${win.reset ? '已重置' : `已用 ${win.used}%`}</span>`).join('')}</span>
  </div>`).join('')}</div>`;
}

function noticeHtml(model) {
  const { account } = model;
  const admin = !!state.session.admin;
  if (!account.enabled) return '';
  if (!account.credentialsReady) return `<p class="notice">${admin ? '点击“编辑”粘贴该账号的 auth.json 后即可开始查询。' : '管理员设置凭据后即可开始查询。'}</p>`;
  if (account.lastError) return `<p class="notice is-error">${escapeHtml(account.lastError)}</p>`;
  if (model.credentialsExpired) return `<p class="notice is-error">凭据已过期，查询会失败。${admin ? '请点击“编辑”粘贴该账号最新的 auth.json。' : '请联系管理员更新凭据。'}</p>`;
  if (model.limited) {
    const recover = model.recoverAt ? `，预计 ${dateTime(model.recoverAt)} 重置后恢复` : '';
    const note = model.flagged ? '' : '接口尚未标记为受限，可能还能少量使用。';
    return `<p class="notice">${model.exhausted ? '额度已用完' : '已达使用上限'}${recover}。${note}</p>`;
  }
  return '';
}

function renderControls() {
  document.querySelectorAll('[data-range]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.range === view.range)));
  document.querySelectorAll('[data-scale]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.scale === view.scale));
    button.disabled = view.table;
  });
  const toggle = $('#tableToggle');
  toggle.setAttribute('aria-pressed', String(view.table));
  toggle.textContent = view.table ? '显示图表' : '显示表格';
  $('#chart').hidden = view.table;
  $('#chartTable').hidden = !view.table;
}

function updateTimes() {
  const now = Date.now();
  document.querySelectorAll('[data-ago]').forEach(element => { element.textContent = formatAgo(now - Number(element.dataset.ago)); });
  document.querySelectorAll('[data-until]').forEach(element => { element.textContent = formatSpan(Number(element.dataset.until) - now); });
}

// ---------- 图表 ----------
function buildSeries() {
  const byId = new Map(state.accounts.map((account, index) => [account.id, { account, index, points: [] }]));
  for (const item of state.snapshots) {
    const entry = byId.get(item.accountId);
    const value = Number(item.primary?.usedPercent);
    const time = Date.parse(item.capturedAt);
    if (entry && Number.isFinite(value) && Number.isFinite(time)) entry.points.push({ t: time, v: value });
  }
  const list = [...byId.values()].filter(entry => entry.points.length);
  list.forEach(entry => entry.points.sort((a, b) => a.t - b.t));
  return list;
}

function lowerBound(points, time) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].t < time) low = middle + 1; else high = middle;
  }
  return low;
}
function nearest(points, time) {
  const index = lowerBound(points, time);
  const before = points[index - 1];
  const after = points[index];
  if (!before || !after) return before || after || null;
  return time - before.t <= after.t - time ? before : after;
}

function niceDomain(low, high) {
  const span = Math.max(high - low, 4);
  let min = Math.max(0, low - span * 0.15);
  let max = Math.min(100, high + span * 0.15);
  const step = [1, 2, 5, 10, 20, 25].find(candidate => (max - min) / candidate <= 5) || 25;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  while ((max - min) / step < 2) {
    if (max + step <= 100) max += step;
    else if (min - step >= 0) min -= step;
    else break;
  }
  return { min, max, step };
}

// 按本地时间对齐的整点刻度：小时级从零点起算，天级落在零点。
function timeTicks(start, end, plotWidth) {
  const maxTicks = Math.max(2, Math.floor(plotWidth / 96));
  const step = TICK_STEPS.find(candidate => (end - start) / candidate <= maxTicks) || TICK_STEPS[TICK_STEPS.length - 1];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const values = [];
  if (step >= DAY) {
    const days = Math.round(step / DAY);
    while (cursor.getTime() < start) cursor.setDate(cursor.getDate() + 1);
    for (; cursor.getTime() <= end; cursor.setDate(cursor.getDate() + days)) values.push(cursor.getTime());
  } else {
    for (let time = cursor.getTime() + Math.ceil((start - cursor.getTime()) / step) * step; time <= end; time += step) values.push(time);
  }
  return { values, step };
}
function tickLabel(time, step) {
  const date = new Date(time);
  return step >= DAY || (date.getHours() === 0 && date.getMinutes() === 0) ? `${date.getMonth() + 1}/${date.getDate()}` : clock(time);
}

// 相邻记录间隔过大（服务停止或查询失败）时断开曲线，不用直线把缺口连起来。
function splitSegments(points, gapLimit) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (current.length && point.t - current[current.length - 1].t > gapLimit) { segments.push(current); current = []; }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
// 点数远多于像素时，每个像素列只保留首、尾、最小、最大四个点，折线外形不变。
function decimate(points, x) {
  const output = [];
  let column = null;
  let group = [];
  const flush = () => {
    const [first, last] = [group[0], group[group.length - 1]];
    const min = group.reduce((a, b) => (b.v < a.v ? b : a));
    const max = group.reduce((a, b) => (b.v > a.v ? b : a));
    for (const point of [...new Set([first, min, max, last])].sort((a, b) => a.t - b.t)) output.push(point);
  };
  for (const point of points) {
    const next = Math.floor(x(point.t));
    if (next !== column && group.length) { flush(); group = []; }
    column = next;
    group.push(point);
  }
  if (group.length) flush();
  return output;
}

// 图表画的是各账号主窗口的已用比例；各账号窗口长度一致时直接写出窗口名。
function chartSubject() {
  const names = [...new Set(series.map(entry => entry.account.latest?.primary?.limitWindowSeconds).filter(Boolean).map(seconds => windowName(seconds)))];
  return names.length === 1 ? `${names[0]}的已用比例` : names.length ? '各账号主额度窗口的已用比例（窗口长度不同）' : '主额度窗口的已用比例';
}

function renderLegend(multi, start) {
  const legend = $('#legend');
  legend.hidden = !multi;
  legend.innerHTML = multi ? series.map(entry => {
    const inRange = entry.points[entry.points.length - 1].t >= start;
    return `<button type="button" class="legend-item${inRange ? '' : ' is-empty'}" data-series="${escapeHtml(entry.account.id)}" aria-pressed="${!view.hidden.includes(entry.account.id)}"${inRange ? '' : ' title="所选时间范围内没有数据"'}><span class="legend-key" style="background:${seriesColor(entry.index)}" aria-hidden="true"></span>${escapeHtml(entry.account.name)}</button>`;
  }).join('') : '';
}

function drawChart() {
  const chart = $('#chart');
  const svg = $('#chartSvg');
  const now = Date.now();
  const multi = series.length > 1;
  const visible = multi ? series.filter(entry => !view.hidden.includes(entry.account.id)) : series;
  const first = series.reduce((min, entry) => Math.min(min, entry.points[0].t), now);
  const start = view.range === 'all' ? Math.min(first, now - 3600e3) : now - Number(view.range) * DAY;
  const end = now;
  const clipped = visible.map(entry => ({ ...entry, points: entry.points.slice(lowerBound(entry.points, start)) })).filter(entry => entry.points.length);
  const count = clipped.reduce((sum, entry) => sum + entry.points.length, 0);
  renderLegend(multi, start);
  $('#chartNote').textContent = series.length === 1 ? `${chartSubject()} · ${series[0].account.name}` : chartSubject();
  if (view.table) {
    chartModel = null;
    renderTable(clipped);
    $('#chartCaption').textContent = count ? `共 ${count} 个记录点` : '';
    return;
  }
  const empty = $('#chartEmpty');
  if (!count) {
    chartModel = null;
    svg.replaceChildren();
    hideTip();
    empty.hidden = false;
    empty.textContent = connection.online === null ? '正在读取数据…'
      : !series.length ? '完成第一次查询后，这里会显示历史曲线。'
        : !visible.length ? '已在图例中隐藏全部账号，点击图例即可重新显示。' : '所选时间范围内没有数据，可以切换到更长的范围。';
    $('#chartCaption').textContent = '';
    return;
  }
  empty.hidden = true;

  const width = chart.clientWidth || 800;
  const height = chart.clientHeight || 320;
  const labeled = clipped.length <= 4;
  const pad = { left: 44, right: labeled ? 48 : 16, top: 12, bottom: 26 };
  const plotWidth = Math.max(40, width - pad.left - pad.right);
  const plotHeight = Math.max(40, height - pad.top - pad.bottom);
  const x = time => pad.left + (time - start) / (end - start) * plotWidth;
  let low = Infinity;
  let high = -Infinity;
  for (const entry of clipped) for (const point of entry.points) { low = Math.min(low, point.v); high = Math.max(high, point.v); }
  const domain = view.scale === 'full' ? { min: 0, max: 100, step: 25 } : niceDomain(low, high);
  const y = value => pad.top + (domain.max - value) / (domain.max - domain.min) * plotHeight;
  const gapLimit = Math.max(staleAfter(), 4 * (end - start) / plotWidth);
  const fixed = value => value.toFixed(1);
  const parts = [];

  for (let value = domain.min; value <= domain.max + 1e-6; value += domain.step) {
    const py = fixed(y(value));
    parts.push(`<line class="${value === domain.min ? 'axis' : 'grid'}" x1="${pad.left}" x2="${pad.left + plotWidth}" y1="${py}" y2="${py}"/>`,
      `<text class="tick" x="${pad.left - 8}" y="${py}" dy="0.32em" text-anchor="end">${Math.round(value)}%</text>`);
  }
  const ticks = timeTicks(start, end, plotWidth);
  for (const tick of ticks.values) {
    const px = x(tick);
    if (px >= pad.left + 16 && px <= pad.left + plotWidth - 16) parts.push(`<text class="tick" x="${fixed(px)}" y="${height - 6}" text-anchor="middle">${tickLabel(tick, ticks.step)}</text>`);
  }

  const toPath = segment => segment.map((point, index) => `${index ? 'L' : 'M'}${fixed(x(point.t))},${fixed(y(point.v))}`).join('');
  const drawn = clipped.map(entry => ({
    entry,
    color: seriesColor(entry.index),
    segments: splitSegments(entry.points, gapLimit).map(segment => (segment.length > plotWidth * 2 ? decimate(segment, x) : segment))
  }));
  if (drawn.length === 1) {
    const base = fixed(pad.top + plotHeight);
    const area = drawn[0].segments.filter(segment => segment.length > 1)
      .map(segment => `${toPath(segment)}L${fixed(x(segment[segment.length - 1].t))},${base}L${fixed(x(segment[0].t))},${base}Z`).join('');
    parts.push(`<path class="area" d="${area}" style="fill:${drawn[0].color}"/>`);
  }
  for (const { color, segments } of drawn) {
    parts.push(`<path class="line" d="${segments.filter(segment => segment.length > 1).map(toPath).join('')}" style="stroke:${color}"/>`);
    for (const [point] of segments.filter(segment => segment.length === 1)) {
      parts.push(`<circle class="dot" cx="${fixed(x(point.t))}" cy="${fixed(y(point.v))}" r="3" style="fill:${color}"/>`);
    }
  }
  // 每条线的末端画圆点；四条以内且末端互不重叠时，在旁边标出最新数值。
  const ends = drawn.map(({ entry, color }) => {
    const last = entry.points[entry.points.length - 1];
    return { color, last, px: x(last.t), py: y(last.v) };
  });
  const crowded = ends.some((a, i) => ends.some((b, j) => j > i && Math.abs(a.py - b.py) < 14 && Math.abs(a.px - b.px) < 44));
  for (const item of ends) {
    parts.push(`<circle class="end-dot" cx="${fixed(item.px)}" cy="${fixed(item.py)}" r="4" style="fill:${item.color}"/>`);
    if (labeled && !crowded) parts.push(`<text class="end-label" x="${fixed(item.px + 8)}" y="${fixed(item.py)}" dy="0.32em">${percent(item.last.v)}</text>`);
  }
  parts.push(`<g class="hover" style="display:none"><line class="crosshair" y1="${pad.top}" y2="${pad.top + plotHeight}"/>${drawn.map(({ color }) => `<circle class="hover-dot" r="4.5" style="fill:${color}"/>`).join('')}</g>`);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = parts.join('');
  chartModel = { x, y, start, end, pad, plotWidth, series: clipped, colors: drawn.map(item => item.color), tolerance: gapLimit / 2 };
  $('#chartCaption').textContent = `共 ${count} 个记录点 · 超过 ${formatSpan(gapLimit)}没有记录的时段断开显示`;
  chart.setAttribute('aria-label', `已用额度变化图（${chartSubject()}），${clipped.length} 个账号，${count} 个记录点。获得焦点后可用左右方向键逐点查看数值。`);
  if (hoverTime !== null) showAt(hoverTime);
}

function renderTable(clipped) {
  const container = $('#chartTable');
  if (!clipped.length) { container.innerHTML = '<p class="table-empty">所选时间范围内没有数据。</p>'; return; }
  const hourly = view.range === '1';
  const rows = new Map();
  for (const entry of clipped) {
    for (const point of entry.points) {
      const bucket = new Date(point.t);
      if (hourly) bucket.setMinutes(0, 0, 0); else bucket.setHours(0, 0, 0, 0);
      const key = bucket.getTime();
      if (!rows.has(key)) rows.set(key, new Map());
      const cells = rows.get(key);
      cells.set(entry.account.id, Math.max(cells.get(entry.account.id) ?? -Infinity, point.v));
    }
  }
  const label = key => (hourly ? `${dayLabel(key)} ${clock(key)}` : dayLabel(key));
  container.innerHTML = `<table><caption>${chartSubject()}：每${hourly ? '小时' : '天'}内的最高值，最新的在前</caption>
    <thead><tr><th scope="col">${hourly ? '时间' : '日期'}</th>${clipped.map(entry => `<th scope="col">${escapeHtml(entry.account.name)}</th>`).join('')}</tr></thead>
    <tbody>${[...rows.keys()].sort((a, b) => b - a).map(key => `<tr><th scope="row">${label(key)}</th>${clipped.map(entry => {
      const value = rows.get(key).get(entry.account.id);
      return `<td>${value === undefined ? '—' : percent(value)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

// 十字线吸附到最近的记录时间，提示框列出该时刻所有账号的数值。
function showAt(time) {
  const model = chartModel;
  const layer = $('#chartSvg .hover');
  if (!model || !layer) return;
  let snap = null;
  for (const entry of model.series) {
    const point = nearest(entry.points, time);
    if (point && (!snap || Math.abs(point.t - time) < Math.abs(snap.t - time))) snap = point;
  }
  if (!snap) return hideTip();
  hoverTime = snap.t;
  const dots = layer.querySelectorAll('.hover-dot');
  const rows = [];
  model.series.forEach((entry, index) => {
    const point = nearest(entry.points, snap.t);
    const shown = !!point && Math.abs(point.t - snap.t) <= model.tolerance;
    dots[index].setAttribute('visibility', shown ? 'visible' : 'hidden');
    if (!shown) return;
    dots[index].setAttribute('cx', model.x(point.t).toFixed(1));
    dots[index].setAttribute('cy', model.y(point.v).toFixed(1));
    rows.push({ name: entry.account.name, value: point.v, color: model.colors[index] });
  });
  const px = model.x(snap.t);
  const crosshair = layer.querySelector('.crosshair');
  crosshair.setAttribute('x1', px.toFixed(1));
  crosshair.setAttribute('x2', px.toFixed(1));
  layer.style.display = '';
  renderTip(snap.t, rows, px);
}

function renderTip(time, rows, px) {
  const tip = $('#chartTip');
  const head = document.createElement('div');
  head.className = 'tip-time';
  head.textContent = `${fullTime(time)} · 已用比例`;
  tip.replaceChildren(head, ...rows.sort((a, b) => b.value - a.value).map(row => {
    const line = document.createElement('div');
    const key = document.createElement('span');
    const value = document.createElement('strong');
    const name = document.createElement('span');
    line.className = 'tip-row';
    key.className = 'tip-key';
    key.style.background = row.color;
    value.textContent = percent(row.value);
    name.textContent = row.name;
    line.append(key, value, name);
    return line;
  }));
  tip.hidden = false;
  const width = $('#chart').clientWidth;
  const left = px + 14 + tip.offsetWidth <= width ? px + 14 : px - 14 - tip.offsetWidth;
  tip.style.left = `${Math.max(0, left)}px`;
}

function hideTip() {
  hoverTime = null;
  $('#chartTip').hidden = true;
  const layer = $('#chartSvg .hover');
  if (layer) layer.style.display = 'none';
}

// 键盘逐点移动：跳过几秒内同时采样的其他账号，直接到下一个采样时刻。
function neighborTime(time, direction) {
  const epsilon = Math.min(chartModel.tolerance, 120000);
  let best = null;
  for (const entry of chartModel.series) {
    const point = direction > 0 ? entry.points[lowerBound(entry.points, time + epsilon)] : entry.points[lowerBound(entry.points, time - epsilon) - 1];
    if (point && (best === null || (direction > 0 ? point.t < best : point.t > best))) best = point.t;
  }
  return best;
}

// ---------- 刷新 ----------
function dataSignature() {
  const last = state.snapshots[state.snapshots.length - 1];
  return JSON.stringify([state.accounts, state.snapshots.length, last?.capturedAt, state.config, state.session]);
}
const cardFlags = model => [model.status.key, model.stale, model.limited, model.credentialsExpired,
  model.windows.map(win => win.reset), model.extras.map(extra => extra.windows.map(win => win.reset))];

// 数据或时间相关的状态变化时才重建对应区域，避免每 30 秒重绘打断悬停、焦点和图例操作。
function refresh() {
  const now = Date.now();
  const models = state.accounts.map((account, index) => describeAccount(account, index, now));
  const data = dataSignature();
  let chartDirty = false;
  if (data !== signatures.data) {
    signatures.data = data;
    series = buildSeries();
    chartDirty = true;
  }
  const cards = JSON.stringify([data, models.map(cardFlags), [...busy], refreshingAll]);
  if (cards !== signatures.cards) {
    signatures.cards = cards;
    renderAdmin();
    renderSummary(models);
    renderAccounts(models);
  }
  renderControls();
  const chart = JSON.stringify([data, view, Math.floor(now / 600000)]);
  if (chartDirty || chart !== signatures.chart) {
    signatures.chart = chart;
    drawChart();
  }
  $('#chartCard').classList.toggle('is-refreshing', refreshingAll);
  renderStatus();
  updateTimes();
}

async function readBody(response) {
  try { return await response.json(); } catch { return {}; }
}
async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  } catch {
    throw new Error('无法连接服务，请确认后端正在运行');
  }
  const data = await readBody(response);
  if (!response.ok) throw Object.assign(new Error(data.error || `请求失败（HTTP ${response.status}）`), { code: data.code });
  return data;
}

async function load() {
  const sequence = ++loadSequence;
  try {
    const [data, session] = await Promise.all([request('/api/state', { cache: 'no-store' }), request('/api/session', { cache: 'no-store' })]);
    if (sequence !== loadSequence) return;
    state = { accounts: data.accounts || [], snapshots: data.snapshots || [], config: data.config || {}, session: { admin: !!session.admin, configured: session.configured !== false } };
    connection = { online: true, syncedAt: Date.now(), error: '' };
  } catch (error) {
    if (sequence === loadSequence) connection = { ...connection, online: false, error: error.message };
    throw error;
  } finally {
    if (sequence === loadSequence) refresh();
  }
}
const reload = () => load().catch(() => {});

// ---------- 操作 ----------
function toast(message, isError = false) {
  const element = $('#toast');
  const icon = document.createElement('span');
  const text = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = isError ? '!' : '✓';
  text.textContent = message;
  element.className = `toast${isError ? ' is-error' : ''}`;
  element.replaceChildren(icon, text);
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, isError ? 7000 : 4000);
}

async function pollAccount(id) {
  const name = accountOf(id)?.name || '账号';
  busy.add(id);
  refresh();
  try {
    await request(`/api/accounts/${encodeURIComponent(id)}/poll`, { method: 'POST' });
    toast(`“${name}”查询完成`);
  } catch (error) {
    toast(`“${name}”查询失败：${error.message}`, true);
  } finally {
    busy.delete(id);
    await reload();
  }
}

async function refreshAll() {
  const button = $('#refreshAll');
  refreshingAll = true;
  button.disabled = true;
  button.textContent = '刷新中…';
  refresh();
  try {
    const { results = [] } = await request('/api/poll', { method: 'POST' });
    const succeeded = results.filter(item => item.snapshot).length;
    const failed = results.filter(item => item.error).length;
    const skipped = results.filter(item => item.skipped).length;
    toast(!results.length ? '没有需要刷新的启用账号'
      : `刷新完成：成功 ${succeeded} 个${failed ? `，失败 ${failed} 个（详见卡片）` : ''}${skipped ? `，跳过 ${skipped} 个未设置凭据的账号` : ''}`, failed > 0);
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshingAll = false;
    button.disabled = false;
    button.textContent = '刷新全部';
    await reload();
  }
}

async function toggleAccount(id) {
  const account = accountOf(id);
  if (!account) return;
  const enabled = !account.enabled;
  if (!enabled && !confirm(`暂停“${account.name}”的查询？\n暂停后不参与自动查询，也不能手动查询；凭据和历史会保留。`)) return;
  try {
    await request(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    toast(enabled ? `已恢复“${account.name}”的查询` : `已暂停“${account.name}”的查询`);
  } catch (error) {
    toast(error.message, true);
  }
  await reload();
}

async function deleteAccount(id) {
  const account = accountOf(id);
  if (!account || !confirm(`删除“${account.name}”？\n该账号的凭据和全部历史快照都会被删除，且无法恢复。`)) return;
  try {
    await request(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`已删除“${account.name}”`);
  } catch (error) {
    toast(error.message, true);
  }
  await reload();
}

function setFormError(selector, message, focusSelector) {
  const element = $(selector);
  element.textContent = message;
  element.hidden = !message;
  if (message && focusSelector) $(focusSelector).focus();
}
async function submitting(selector, label, task) {
  const button = $(selector);
  const text = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { await task(); } finally { button.disabled = false; button.textContent = text; }
}

function credentialSummary(account) {
  if (!account.credentialsReady) return '当前没有凭据，请粘贴该账号的 auth.json。';
  const expiresAt = account.credentialsExpiresAt ? Date.parse(account.credentialsExpiresAt) : null;
  if (expiresAt === null) return '当前凭据已设置，留空即可保留。';
  return expiresAt <= Date.now() ? `当前凭据已于 ${dateTime(expiresAt)} 过期，请粘贴最新的 auth.json。` : `当前凭据将于 ${dateTime(expiresAt)} 过期，留空即可保留。`;
}

function openAccountDialog(account = null) {
  $('#accountDialogTitle').textContent = account ? '编辑账号' : '添加账号';
  $('#accountId').value = account?.id || '';
  $('#accountName').value = account?.name || '';
  $('#credentials').value = '';
  $('#credentials').placeholder = account ? '如需更换凭据，请粘贴新的完整 JSON' : '粘贴该账号 auth.json 的完整 JSON 内容';
  $('#credentialsStatus').textContent = account ? credentialSummary(account) : '';
  $('#credentialsStatus').hidden = !account;
  $('#accountEnabled').checked = account ? account.enabled : true;
  setFormError('#accountError', '');
  $('#accountDialog').showModal();
  $('#accountName').focus();
}

async function submitAccount(event) {
  event.preventDefault();
  const id = $('#accountId').value;
  const name = $('#accountName').value.trim();
  const credentials = $('#credentials').value.trim();
  if (!name) return setFormError('#accountError', '请填写账号名称', '#accountName');
  if (!id && !credentials) return setFormError('#accountError', '请粘贴该账号 auth.json 的内容', '#credentials');
  if (credentials) {
    let value;
    try { value = JSON.parse(credentials); } catch { return setFormError('#accountError', '粘贴的内容不是有效的 JSON，请复制 auth.json 的完整内容', '#credentials'); }
    if (!value?.access_token && !value?.tokens?.access_token) return setFormError('#accountError', '这段 JSON 中没有 access_token，请确认复制的是 auth.json', '#credentials');
  }
  const payload = { name, enabled: $('#accountEnabled').checked };
  if (credentials) payload.credentials = credentials;
  await submitting('#accountSubmit', '保存中…', async () => {
    try {
      await request(id ? `/api/accounts/${encodeURIComponent(id)}` : '/api/accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      setFormError('#accountError', error.message);
      return;
    }
    $('#accountDialog').close();
    toast(id ? '账号已更新' : '账号已添加');
    await reload();
  });
}

function openLoginDialog() {
  const configured = state.session.configured !== false;
  $('#loginUnconfigured').hidden = configured;
  $('#loginPassword').disabled = !configured;
  $('#loginPassword').value = '';
  $('#loginSubmit').disabled = !configured;
  setFormError('#loginError', '');
  $('#loginDialog').showModal();
  if (configured) $('#loginPassword').focus();
}

async function submitLogin(event) {
  event.preventDefault();
  const password = $('#loginPassword').value;
  if (!password) return setFormError('#loginError', '请输入管理员密码', '#loginPassword');
  await submitting('#loginSubmit', '登录中…', async () => {
    try {
      await request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    } catch (error) {
      setFormError('#loginError', error.message);
      $('#loginPassword').select();
      return;
    }
    $('#loginDialog').close();
    toast('已进入管理员模式');
    await reload();
  });
}

function openSettingsDialog() {
  $('#settingsEnabled').checked = state.config.enabled !== false;
  $('#settingsInterval').value = state.config.intervalMinutes ?? 5;
  $('#settingsTimeout').value = state.config.timeoutSeconds ?? 10;
  setFormError('#settingsError', '');
  $('#settingsDialog').showModal();
}

async function submitSettings(event) {
  event.preventDefault();
  const enabled = $('#settingsEnabled').checked;
  const intervalMinutes = Number($('#settingsInterval').value);
  const timeoutSeconds = Number($('#settingsTimeout').value);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) return setFormError('#settingsError', '查询间隔需要是 1～1440 之间的整数', '#settingsInterval');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return setFormError('#settingsError', '请求超时需要是 1～120 之间的整数', '#settingsTimeout');
  await submitting('#settingsSubmit', '保存中…', async () => {
    let saved;
    try {
      saved = await request('/api/config', { method: 'POST', body: JSON.stringify({ enabled, intervalMinutes, timeoutSeconds }) });
    } catch (error) {
      setFormError('#settingsError', error.message);
      return;
    }
    $('#settingsDialog').close();
    toast(saved.enabled ? `自动查询已开启：每 ${saved.intervalMinutes} 分钟一次` : '自动查询已关闭');
    await reload();
  });
}

// ---------- 事件 ----------
$('#refreshAll').addEventListener('click', refreshAll);
$('#addAccount').addEventListener('click', () => openAccountDialog());
$('#openSettings').addEventListener('click', openSettingsDialog);
$('#adminLogin').addEventListener('click', openLoginDialog);
$('#adminLogout').addEventListener('click', async () => {
  try {
    await request('/api/logout', { method: 'POST' });
    toast('已退出管理员模式');
  } catch (error) {
    toast(error.message, true);
  }
  await reload();
});
$('#accountForm').addEventListener('submit', submitAccount);
$('#loginForm').addEventListener('submit', submitLogin);
$('#settingsForm').addEventListener('submit', submitSettings);

document.querySelectorAll('dialog').forEach(dialog => {
  // 只有按下和松开都在遮罩上才关闭，避免在输入框里拖选文字时误关对话框。
  let pressedOnBackdrop = false;
  dialog.addEventListener('pointerdown', event => { pressedOnBackdrop = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (pressedOnBackdrop && event.target === dialog) dialog.close();
    pressedOnBackdrop = false;
  });
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
});

$('#accounts').addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'add') return openAccountDialog();
  const id = event.target.closest('[data-account-id]')?.dataset.accountId;
  if (!id) return;
  if (action === 'poll') return pollAccount(id);
  if (!state.session.admin) return;
  if (action === 'toggle') toggleAccount(id);
  if (action === 'edit' && accountOf(id)) openAccountDialog(accountOf(id));
  if (action === 'delete') deleteAccount(id);
});

$('#rangeControl').addEventListener('click', event => {
  const range = event.target.closest('[data-range]')?.dataset.range;
  if (!range || range === view.range) return;
  view.range = range;
  saveView();
  refresh();
});
$('#scaleControl').addEventListener('click', event => {
  const scale = event.target.closest('[data-scale]')?.dataset.scale;
  if (!scale || scale === view.scale) return;
  view.scale = scale;
  saveView();
  refresh();
});
$('#tableToggle').addEventListener('click', () => {
  view.table = !view.table;
  saveView();
  hideTip();
  refresh();
});
$('#legend').addEventListener('click', event => {
  const id = event.target.closest('[data-series]')?.dataset.series;
  if (!id) return;
  const known = view.hidden.filter(item => series.some(entry => entry.account.id === item));
  view.hidden = known.includes(id) ? known.filter(item => item !== id) : [...known, id];
  saveView();
  refresh();
  $(`#legend [data-series="${CSS.escape(id)}"]`)?.focus();
});

const chartElement = $('#chart');
chartElement.addEventListener('pointermove', event => {
  if (!chartModel) return;
  const { pad, plotWidth, start, end } = chartModel;
  const px = Math.max(pad.left, Math.min(pad.left + plotWidth, event.clientX - chartElement.getBoundingClientRect().left));
  showAt(start + (px - pad.left) / plotWidth * (end - start));
});
chartElement.addEventListener('pointerleave', hideTip);
chartElement.addEventListener('focus', () => { if (chartModel && hoverTime === null) showAt(chartModel.end); });
chartElement.addEventListener('blur', hideTip);
chartElement.addEventListener('keydown', event => {
  if (!chartModel) return;
  const current = hoverTime ?? chartModel.end;
  let target;
  if (event.key === 'ArrowLeft') target = neighborTime(current, -1);
  else if (event.key === 'ArrowRight') target = neighborTime(current, 1);
  else if (event.key === 'Home') target = chartModel.start;
  else if (event.key === 'End') target = chartModel.end;
  else if (event.key === 'Escape') return hideTip();
  else return;
  event.preventDefault();
  if (target !== null) showAt(target);
});

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!view.table) drawChart(); }, 120);
}).observe(chartElement);

load().catch(error => toast(error.message, true));
setInterval(() => { if (!document.hidden) reload(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });

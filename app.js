const $ = selector => document.querySelector(selector);

let state = { accounts: [], snapshots: [], config: {}, session: { admin: false } };
let chartState = { data: [], minTime: 0, maxTime: 0, scale: { min: 0, max: 100 } };
const colors = ['#1e9a7b', '#3877d6', '#d16b3f', '#8b63c7', '#c58b22', '#3c9a9a'];
const rangeSelect = $('#range');
const accountFilter = $('#accountFilter');
const chartScale = $('#chartScale');
const chart = $('#chart');
const dialog = $('#accountDialog');

function colorForAccount(accountId) {
  const text = String(accountId || 'unknown');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return colors[(hash >>> 0) % colors.length];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function formatAgo(value) {
  if (!value) return '尚未查询';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value)) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}
function formatReset(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '重置时间未知';
  const total = Math.round(Number(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `约 ${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${minutes} 分钟后重置`;
}
function windowLabel(seconds) {
  if (!seconds) return '账户窗口';
  const hours = Math.round(Number(seconds) / 3600);
  return hours >= 24 ? `最近 ${Math.round(hours / 24)} 天窗口` : `${hours} 小时窗口`;
}
function latestSnapshot(account) { return account.latest || null; }
function rangeSnapshots() {
  const days = rangeSelect.value;
  const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 864e5;
  const accountId = accountFilter.value;
  return state.snapshots.filter(item => (!accountId || accountId === 'all' || item.accountId === accountId) && new Date(item.capturedAt).getTime() >= cutoff);
}
function showToast(message, isError = false) {
  const toast = $('#toast') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toast' }));
  toast.className = `toast ${isError ? 'error' : ''}`;
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${isError ? '!' : '✓'}</span><span>${escapeHtml(message)}</span>`;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 5200);
}

function renderSummary() {
  const latest = state.accounts.map(latestSnapshot).filter(Boolean);
  const healthy = state.accounts.filter(account => account.enabled && account.credentialsReady && account.latest?.allowed !== false && !account.lastError && account.latest).length;
  const max = latest.reduce((best, item) => (item.primary?.usedPercent > (best?.primary?.usedPercent ?? -1) ? item : best), null);
  const failures = state.accounts.filter(account => account.credentialsReady && account.lastError).length;
  const missing = state.accounts.filter(account => !account.credentialsReady).length;
  $('#accountCount').textContent = state.accounts.length;
  $('#healthyCount').textContent = healthy;
  $('#maxUsage').textContent = max?.primary ? `${max.primary.usedPercent}%` : '—';
  $('#maxUsageName').textContent = max ? (state.accounts.find(account => account.id === max.accountId)?.name || '未知账号') : '暂无数据';
  $('#autoState').textContent = state.config.enabled ? `开启 · 每 ${state.config.intervalMinutes} 分钟` : '关闭';
  $('#statusText').textContent = !state.accounts.length ? '请添加账号' : failures ? `${failures} 个账号需要处理` : missing ? `${missing} 个账号待设置凭据` : '全部账号连接正常';
  $('#connectionDot').classList.toggle('offline', failures > 0);
}

function renderFilter() {
  const current = accountFilter.value || 'all';
  accountFilter.innerHTML = '<option value="all">全部账号</option>' + state.accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join('');
  accountFilter.value = state.accounts.some(account => account.id === current) ? current : 'all';
}

function statusFor(account) {
  if (!account.enabled) return { text: '已暂停', className: 'paused' };
  if (!account.credentialsReady) return { text: '待设置凭据', className: 'pending' };
  if (account.lastError) return { text: '查询失败', className: 'error' };
  if (!account.latest) return { text: '待查询', className: 'pending' };
  if (!account.latest.allowed || account.latest.limitReached) return { text: '已达限制', className: 'warning' };
  return { text: '正常', className: 'ok' };
}

function renderAccounts() {
  const container = $('#accounts');
  if (!state.accounts.length) {
    container.innerHTML = state.session.admin ? '<div class="empty-accounts"><div class="empty-icon">＋</div><h3>还没有维护账号</h3><p>添加账号并粘贴各自的 auth.json JSON 内容，就可以开始独立记录用量。</p><button class="button primary" data-action="add">添加第一个账号</button></div>' : '<div class="empty-accounts"><h3>还没有维护账号</h3><p>请登录管理员模式后添加账号。</p></div>';
    return;
  }
  container.innerHTML = state.accounts.map((account, index) => {
    const latest = latestSnapshot(account);
    const status = statusFor(account);
    const usage = latest?.primary?.usedPercent;
    const maxWidth = Number.isFinite(Number(usage)) ? Math.max(0, Math.min(100, Number(usage))) : 0;
    const color = colorForAccount(account.id);
    return `<article class="account-card ${status.className}" data-account-id="${escapeHtml(account.id)}">
      <div class="account-head"><div class="account-title"><span class="account-color" style="background:${color}"></span><h3>${escapeHtml(account.name)}</h3></div><span class="status-pill ${status.className}"><i></i>${status.text}</span></div>
      <div class="account-meta"><span>${escapeHtml(account.email || '尚未识别账号')}</span><span class="credential-state ${account.credentialsReady ? 'ready' : 'missing'}">${account.credentialsReady ? '凭据已设置 · 本地独立保存' : '尚未设置凭据 · 请编辑账号粘贴 JSON'}</span></div>
      <div class="usage-row"><div><span class="label">${escapeHtml(windowLabel(latest?.primary?.limitWindowSeconds))}</span><strong>${latest?.primary ? `${latest.primary.usedPercent}%` : '—'}</strong></div><div class="usage-reset">${latest?.primary ? escapeHtml(formatReset(latest.primary.resetAfterSeconds)) : '完成查询后显示'}</div></div>
      <div class="usage-bar"><span style="width:${maxWidth}%;background:${color}"></span></div>
      <div class="account-foot"><span>${latest ? `最后更新 · ${formatAgo(latest.capturedAt)}` : '还没有快照'} · ${account.snapshotCount || 0} 条记录</span><div class="card-actions"><button data-action="poll" class="small-button">查询</button>${state.session.admin ? '<button data-action="edit" class="small-button">编辑</button><button data-action="delete" class="small-button danger">删除</button>' : ''}</div></div>
      ${account.lastError && account.credentialsReady ? `<div class="account-error">${escapeHtml(account.lastError)}</div>` : ''}
    </article>`;
  }).join('');
}

function calculateScale(values) {
  if (!values.length) return { min: 0, max: 100 };
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(maxValue - minValue, 4);
  const padding = Math.max(2, spread * 0.18);
  let min = Math.max(0, Math.floor((minValue - padding) / 5) * 5);
  let max = Math.min(100, Math.ceil((maxValue + padding) / 5) * 5);
  if (max - min < 10) { min = Math.max(0, min - 5); max = Math.min(100, max + 5); }
  return { min, max: max === min ? Math.min(100, min + 10) : max };
}

function drawChart(data) {
  $('#count').textContent = data.length;
  if (!data.length) {
    chart.innerHTML = '<div class="empty">当前范围内还没有数据。</div>';
    $('#legend').innerHTML = '';
    chartState = { data: [], minTime: 0, maxTime: 0, scale: { min: 0, max: 100 } };
    return;
  }
  const groups = new Map();
  data.forEach(item => { if (!groups.has(item.accountId)) groups.set(item.accountId, []); groups.get(item.accountId).push(item); });
  const values = data.map(item => Number(item.primary?.usedPercent)).filter(Number.isFinite);
  const scale = chartScale.value === 'full' ? { min: 0, max: 100 } : calculateScale(values);
  const width = chart.clientWidth || 800;
  const height = chart.clientHeight || 370;
  const padding = { left: 44, right: 20, top: 18, bottom: 34 };
  const times = data.map(item => new Date(item.capturedAt).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);
  const x = time => minTime === maxTime ? (padding.left + width - padding.right) / 2 : padding.left + (time - minTime) * (width - padding.left - padding.right) / timeSpan;
  const y = value => padding.top + (scale.max - value) * (height - padding.top - padding.bottom) / Math.max(1, scale.max - scale.min);
  let grid = '';
  for (let i = 0; i <= 4; i++) { const value = scale.min + (scale.max - scale.min) * i / 4; grid += `<line class="grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}"/><text class="axis" x="${padding.left - 10}" y="${y(value) + 4}" text-anchor="end">${Math.round(value)}%</text>`; }
  const series = [...groups.entries()].map(([accountId, items]) => {
    items.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const points = items.filter(item => Number.isFinite(Number(item.primary?.usedPercent))).map(item => `${x(new Date(item.capturedAt).getTime())},${y(Number(item.primary.usedPercent))}`).join(' ');
    const account = state.accounts.find(item => item.id === accountId);
    return { accountId, items, points, color: colorForAccount(accountId), name: account?.name || '未知账号' };
  });
  const labelCount = Math.min(7, Math.max(3, Math.floor(width / 180)));
  const indexes = [...new Set(Array.from({ length: labelCount }, (_, index) => Math.round(index * (data.length - 1) / (labelCount - 1))))];
  const labels = indexes.map(index => { const date = new Date(data.slice().sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt))[index].capturedAt); return `<text class="axis" x="${x(date.getTime())}" y="${height - 8}" text-anchor="middle">${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}</text>`; }).join('');
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs>${series.map(item => `<linearGradient id="fill-${item.accountId}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${item.color}" stop-opacity=".12"/><stop offset="1" stop-color="${item.color}" stop-opacity="0"/></linearGradient>`).join('')}</defs>${grid}${series.map(item => `<polyline class="line" points="${item.points}" style="stroke:${item.color}"/>`).join('')}${labels}</svg>`;
  $('#legend').innerHTML = series.map(item => `<span><i style="background:${item.color}"></i>${escapeHtml(item.name)}</span>`).join('');
  chartState = { data, minTime, maxTime, scale, padding, width, height };
}

function showTooltip(event) {
  if (!chartState.data.length) return;
  const rect = chart.getBoundingClientRect();
  const usable = Math.max(1, rect.width - chartState.padding.left - chartState.padding.right);
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - chartState.padding.left) / usable));
  const targetTime = chartState.minTime + ratio * Math.max(1, chartState.maxTime - chartState.minTime);
  const item = chartState.data.reduce((best, current) => Math.abs(new Date(current.capturedAt) - targetTime) < Math.abs(new Date(best.capturedAt) - targetTime) ? current : best);
  const value = Number(item.primary?.usedPercent || 0);
  const x = chartState.minTime === chartState.maxTime ? (chartState.padding.left + rect.width - chartState.padding.right) / 2 : chartState.padding.left + (new Date(item.capturedAt).getTime() - chartState.minTime) * usable / Math.max(1, chartState.maxTime - chartState.minTime);
  const y = chartState.padding.top + (chartState.scale.max - value) * (rect.height - chartState.padding.top - chartState.padding.bottom) / Math.max(1, chartState.scale.max - chartState.scale.min);
  const account = state.accounts.find(entry => entry.id === item.accountId);
  const dot = chart.querySelector('.hover-dot') || chart.appendChild(document.createElement('div'));
  const color = colorForAccount(item.accountId);
  dot.className = 'hover-dot'; dot.style.left = `${x}px`; dot.style.top = `${y}px`; dot.style.background = color; dot.style.boxShadow = `0 0 0 2px ${color}`;
  const tooltip = chart.querySelector('.tooltip') || chart.appendChild(document.createElement('div'));
  tooltip.className = 'tooltip'; tooltip.innerHTML = `<strong>${escapeHtml(new Date(item.capturedAt).toLocaleString('zh-CN', { hour12: false }))}</strong><br>${escapeHtml(account?.name || '账号')}：${value}%`;
  tooltip.style.left = `${x}px`; tooltip.style.top = `${y}px`; tooltip.hidden = false;
}
function hideTooltip() { chart.querySelector('.hover-dot')?.remove(); const tooltip = chart.querySelector('.tooltip'); if (tooltip) tooltip.hidden = true; }

function renderAdminControls() { const admin = !!state.session?.admin; document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !admin; }); $('#adminLogin').hidden = admin; $('#adminLogout').hidden = !admin; }
function render() { renderAdminControls(); renderSummary(); renderFilter(); renderAccounts(); drawChart(rangeSnapshots()); }

async function load() {
  const response = await fetch('/api/state');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '读取数据失败');
  state = { ...data, session: await fetch('/api/session').then(response => response.json()) };
  render();
}

async function pollAccount(id) {
  const button = document.querySelector(`[data-account-id="${CSS.escape(id)}"] [data-action="poll"]`);
  if (button) { button.disabled = true; button.textContent = '查询中'; }
  try {
    const response = await fetch(`/api/accounts/${encodeURIComponent(id)}/poll`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '查询失败');
    await load();
    showToast('账号查询完成');
  } catch (error) { await load().catch(() => {}); showToast(error.message, true); }
}

async function refreshAll() {
  const button = $('#refreshAll'); button.disabled = true; button.textContent = '刷新中…';
  try {
    const response = await fetch('/api/poll', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '刷新失败');
    await load();
    const failures = (data.results || []).filter(item => item.error);
    const skipped = (data.results || []).filter(item => item.skipped).length;
    showToast(failures.length ? `${failures.length} 个账号查询失败，请查看卡片提示` : skipped ? `查询完成，跳过 ${skipped} 个未设置凭据的账号` : '全部账号已刷新', failures.length > 0);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = '刷新全部'; }
}

function openDialog(account = null) {
  $('#dialogTitle').textContent = account ? '编辑账号' : '添加账号';
  $('#accountId').value = account?.id || '';
  $('#accountName').value = account?.name || '';
  $('#credentials').value = '';
  $('#credentials').placeholder = account?.credentialsReady ? '留空保留现有凭据；如需更换，请粘贴新的完整 JSON' : '粘贴该账号 auth.json 的完整 JSON 内容';
  $('#accountEnabled').checked = account ? account.enabled : true;
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => $('#accountName').focus(), 0);
}
function closeDialog() { if (dialog.open) dialog.close(); else dialog.removeAttribute('open'); }

async function saveAccount(event) {
  event.preventDefault();
  const id = $('#accountId').value;
  const credentials = $('#credentials').value.trim();
  const payload = { name: $('#accountName').value.trim(), enabled: $('#accountEnabled').checked };
  if (!payload.name) return showToast('请填写账号名称', true);
  if (!id && !credentials) return showToast('请粘贴该账号 auth.json 的 JSON 内容', true);
  if (credentials) payload.credentials = credentials;
  const response = await fetch(id ? `/api/accounts/${encodeURIComponent(id)}` : '/api/accounts', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) return showToast(data.error || '保存失败', true);
  closeDialog(); await load(); showToast(id ? '账号信息已更新' : '账号已添加');
}

async function deleteAccount(id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account || !confirm(`确定删除“${account.name}”吗？该账号的历史快照也会一并删除。`)) return;
  const response = await fetch(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) return showToast(data.error || '删除失败', true);
  await load(); showToast('账号及其历史已删除');
}

async function updateSettings() {
  const current = state.config.enabled ? state.config.intervalMinutes : 0;
  const input = prompt('自动查询间隔（分钟）\n输入 0 可关闭自动查询。建议 5～15 分钟。', String(current));
  if (input === null) return;
  const minutes = Number(input);
  if (!Number.isFinite(minutes) || minutes < 0) return showToast('请输入不小于 0 的数字', true);
  const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: minutes > 0, intervalMinutes: minutes || state.config.intervalMinutes }) });
  if (!response.ok) return showToast('设置保存失败', true);
  await load(); showToast(minutes > 0 ? `已设置为每 ${minutes} 分钟查询` : '自动查询已关闭');
}

$('#addAccount').addEventListener('click', () => openDialog());
$('#adminLogin').addEventListener('click', async () => { const password = prompt('请输入管理员密码'); if (password === null) return; const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); if (!response.ok) return showToast((await response.json()).error || '登录失败', true); await load(); showToast('已进入管理员模式'); });
$('#adminLogout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); await load(); showToast('已退出管理员模式'); });
$('#refreshAll').addEventListener('click', refreshAll);
$('#settings').addEventListener('click', updateSettings);
$('#closeDialog').addEventListener('click', closeDialog);
$('#cancelDialog').addEventListener('click', closeDialog);
$('#accountForm').addEventListener('submit', saveAccount);
$('#accounts').addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'add') return openDialog();
  const card = event.target.closest('[data-account-id]');
  if (!card) return;
  const id = card.dataset.accountId;
  if (action === 'poll') pollAccount(id);
  if (action === 'edit' && state.session.admin) openDialog(state.accounts.find(account => account.id === id));
  if (action === 'delete' && state.session.admin) deleteAccount(id);
});
rangeSelect.addEventListener('change', () => drawChart(rangeSnapshots()));
accountFilter.addEventListener('change', () => drawChart(rangeSnapshots()));
chartScale.addEventListener('change', () => drawChart(rangeSnapshots()));
chart.addEventListener('mousemove', showTooltip);
chart.addEventListener('mouseleave', hideTooltip);
window.addEventListener('resize', () => drawChart(rangeSnapshots()));
dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });

load().catch(error => { $('#statusText').textContent = error.message; $('#connectionDot').classList.add('offline'); showToast(error.message, true); });
setInterval(() => load().catch(() => {}), 30000);

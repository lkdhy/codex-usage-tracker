const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// `root` reuses an existing directory to simulate a restart; `prepare` writes data files before server.js loads.
function fixture(t, { root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tracker-test-')), prepare } = {}) {
  let server;
  t.after(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  prepare?.(root);
  const context = vm.createContext({
    __dirname: root, console, Buffer, URL, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, process: { env: { CODEX_ADMIN_PASSWORD: 'test-admin' } },
    fetch: async () => { throw new Error('Unexpected upstream request'); },
    require: name => name === 'http' ? {
      createServer(handler) {
        server = http.createServer(handler);
        server.listen = () => server;
        return server;
      }
    } : require(name)
  });
  vm.runInContext(source, context);
  return {
    root, context,
    run: code => vm.runInContext(code, context),
    async start() {
      await new Promise(resolve => http.Server.prototype.listen.call(server, 0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    }
  };
}

function addAccount(f, credentials = true) {
  f.run(`accounts.push({ id: 'a', name: 'A', enabled: true, lastError: '旧错误' });
    ${credentials ? "saveCredentials(accounts[0], { access_token: 'test-only' });" : ''}`);
}

function writeData(root, name, text) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', name), text);
}
function readData(root, name) { return fs.readFileSync(path.join(root, 'data', name), 'utf8'); }

async function login(base) {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin' }) });
  assert.equal(response.status, 200);
  await response.text();
  return response.headers.get('set-cookie').split(';')[0];
}

test('missing credentials are skipped and manual polling does not persist an error', async t => {
  const f = fixture(t);
  addAccount(f, false);
  const result = await f.run('pollAll()');
  assert.equal(result[0].skipped, true);
  assert.equal(f.run('accounts[0].lastError'), null);
  await assert.rejects(f.run("pollAccount('a')"), { code: 'CREDENTIALS_MISSING' });
  assert.equal(f.run('accounts[0].lastError'), null);
});

test('paused accounts retain their history and cannot be polled individually', async t => {
  const f = fixture(t);
  addAccount(f);
  f.run("accounts[0].enabled = false; snapshots.push({ accountId: 'a', capturedAt: '2026-01-01T00:00:00.000Z' });");
  await assert.rejects(f.run("pollAccount('a')"), { code: 'ACCOUNT_PAUSED', statusCode: 409 });
  assert.equal(f.run('snapshots.length'), 1);
  assert.equal(f.run('accounts[0].enabled'), false);
});

test('retention keeps the latest 20000 records per account in original order', t => {
  const f = fixture(t);
  f.run(`snapshots = Array.from({length: 20003}, (_, i) => [
    {accountId: 'a', index: i}, {accountId: 'b', index: i}
  ]).flat(); snapshots.push({accountId: 'c', index: 0}); saveSnapshots();`);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'data/snapshots.json')));
  for (const id of ['a', 'b']) {
    const rows = saved.filter(row => row.accountId === id);
    assert.equal(rows.length, 20000);
    assert.equal(rows[0].index, 3);
    assert.equal(rows.at(-1).index, 20002);
  }
  assert.equal(saved.at(-1).accountId, 'c');
});

test('atomic replacement preserves old JSON when rename fails and removes temporary files', t => {
  const f = fixture(t);
  f.run("writeJson(CONFIG_FILE, {version: 1})");
  // Wrap fs in this isolated VM rather than altering the process-wide module.
  const realFs = require('fs');
  const isolatedFs = Object.create(realFs);
  isolatedFs.renameSync = () => { throw new Error('simulated rename failure'); };
  f.context.require = name => name === 'fs' ? isolatedFs : require(name);
  // writeJson closes over fs, so inject only the failure around a second VM helper.
  const writer = vm.runInNewContext(`const fs = require('fs'); const crypto = require('crypto');
    ${f.run('writeJson.toString()')}; writeJson`, { require: f.context.require });
  const target = path.join(f.root, 'data/config.json');
  assert.throws(() => writer(target, { version: 2 }), /rename failure/);
  assert.equal(JSON.parse(fs.readFileSync(target)).version, 1);
  assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.endsWith('.tmp')), false);
  f.run('writeJson(CONFIG_FILE, {version: 3})');
  assert.equal(JSON.parse(fs.readFileSync(target)).version, 3);
});

test('HTTP rejects oversized fixed and chunked bodies and invalid JSON without mutation', async t => {
  const f = fixture(t);
  const base = await f.start();
  const anonymous = await fetch(`${base}/api/config`, { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 403);
  await anonymous.text();
  // Log in first: without a session requireAdmin answers 403 before the body is ever read.
  const cookie = await login(base);
  for (const [body, status] of [['x'.repeat(1024 * 1024 + 1), 413], ['{', 400], ['null', 400]]) {
    const response = await fetch(`${base}/api/config`, { method: 'POST', headers: { cookie }, body });
    assert.equal(response.status, status);
    await response.text();
  }
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/config`, { method: 'POST', headers: { cookie } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    for (let i = 0; i < 17; i++) req.write(Buffer.alloc(65536, 120));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal(fs.existsSync(path.join(f.root, 'data/config.json')), false);
  const good = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ enabled: false, intervalMinutes: 6 })
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).intervalMinutes, 6);
});

test('upstream failures are classified and never stored as snapshots', async t => {
  const f = fixture(t);
  addAccount(f);
  const cases = [
    [401, '{}', 'AUTH_EXPIRED'], [403, '{}', 'UPSTREAM_FORBIDDEN'],
    [404, '{}', 'UPSTREAM_ENDPOINT'], [429, '{}', 'UPSTREAM_RATE_LIMIT'],
    [503, '{}', 'UPSTREAM_HTTP'], [200, '<html>login</html>', 'UPSTREAM_FORMAT'],
    [200, '{}', 'UPSTREAM_SCHEMA'], [200, 'null', 'UPSTREAM_SCHEMA'],
    [200, '{"rate_limit":{"primary_window":{}}}', 'UPSTREAM_SCHEMA'],
    [200, '{"rate_limit":{"primary_window":{"used_percent":false}}}', 'UPSTREAM_SCHEMA']
  ];
  for (const [status, body, code] of cases) {
    f.context.fetch = async () => new Response(body, { status });
    await assert.rejects(f.run("pollAccount('a')"), { code });
    assert.equal(f.run('accounts[0].lastErrorCode'), code);
    assert.equal(f.run('snapshots.length'), 0);
  }
  for (const [error, code] of [
    [new Error('network'), 'UPSTREAM_NETWORK'],
    [Object.assign(new Error('timeout'), { name: 'AbortError' }), 'UPSTREAM_TIMEOUT']
  ]) {
    f.context.fetch = async () => { throw error; };
    await assert.rejects(f.run("pollAccount('a')"), { code });
  }
  for (const raw of [
    { rate_limit: { primary_window: { used_percent: 0 } } },
    { rateLimit: { primary: { usedPercent: 25, windowDurationSecs: 18000 } } }
  ]) {
    f.context.fetch = async () => new Response(JSON.stringify(raw));
    await f.run("pollAccount('a')");
  }
  assert.equal(f.run('snapshots.length'), 2);
  assert.equal(f.run('accounts[0].lastError'), null);
  assert.equal(f.run('accounts[0].lastErrorCode'), null);
});

test('malformed request URLs get 400 without taking the server down', async t => {
  const f = fixture(t);
  const base = await f.start();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1', () => {
      socket.write('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('no response to GET //')));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${base}/api/session`)).status, 200);
});

test('unreadable data files stop startup instead of being replaced with empty data', t => {
  for (const [name, text, message] of [
    ['snapshots.json', '[{"accountId":"a"', /snapshots\.json/],
    ['accounts.json', '{}', /accounts\.json/]
  ]) {
    let root;
    assert.throws(() => fixture(t, { prepare(dir) {
      root = dir;
      writeData(dir, 'accounts.json', '[{"id":"a","name":"A"}]');
      writeData(dir, 'snapshots.json', '[]');
      writeData(dir, name, text);
    } }), message);
    assert.equal(readData(root, name), text);
  }
});

test('legacy data is migrated once and later restarts neither rewrite nor split accounts', t => {
  const f = fixture(t, { prepare: root => writeData(root, 'snapshots.json', JSON.stringify([
    { capturedAt: '2026-01-01T00:00:00.000Z', raw: { account_id: 'remote-X' } },
    { capturedAt: '2026-01-02T00:00:00.000Z', raw: { account_id: 'remote-Y' } }
  ])) });
  assert.equal(f.run("accounts.map(account => account.name).join('|')"), '默认账号（历史）|默认账号（当前）');
  assert.equal(JSON.parse(readData(f.root, 'meta.json')).schemaVersion, 2);
  // One account whose history spans two remote accounts must survive a restart untouched.
  const accounts = JSON.stringify([{ id: 'a', name: 'A', enabled: true }]);
  const snapshots = JSON.stringify([
    { accountId: 'a', remoteAccountId: 'remote-X', capturedAt: '2026-01-01T00:00:00.000Z' },
    { accountId: 'a', remoteAccountId: 'remote-Y', capturedAt: '2026-01-02T00:00:00.000Z' }
  ]);
  writeData(f.root, 'accounts.json', accounts);
  writeData(f.root, 'snapshots.json', snapshots);
  const restarted = fixture(t, { root: f.root });
  assert.equal(restarted.run('accounts.length'), 1);
  assert.equal(readData(f.root, 'accounts.json'), accounts);
  assert.equal(readData(f.root, 'snapshots.json'), snapshots);
});

test('in-flight polls reject duplicates and never write back after the account is deleted', async t => {
  const f = fixture(t);
  addAccount(f);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.context.fetch = async () => {
    await gate;
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }));
  };
  const base = await f.start();
  const cookie = await login(base);
  const inflight = f.run("pollAccount('a')");
  const duplicate = await fetch(`${base}/api/accounts/a/poll`, { method: 'POST' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'POLL_IN_PROGRESS');
  const removed = await fetch(`${base}/api/accounts/a`, { method: 'DELETE', headers: { cookie } });
  assert.equal(removed.status, 200);
  await removed.text();
  release();
  await assert.rejects(inflight, { code: 'ACCOUNT_NOT_FOUND' });
  assert.equal(f.run('snapshots.length'), 0);
  assert.equal(readData(f.root, 'snapshots.json'), '[]');
  const missing = await fetch(`${base}/api/accounts/a/poll`, { method: 'POST' });
  assert.equal(missing.status, 404);
  await missing.text();
});

test('credential updates keep the remote account binding and change nothing when rejected', async t => {
  const f = fixture(t);
  f.run("accounts.push({ id: 'a', name: 'A', enabled: true }); saveCredentials(accounts[0], { tokens: { access_token: 'x1', account_id: 'remote-X' } });");
  // Tokens starting with "x" belong to remote-X upstream; any other token belongs to remote-Y.
  f.context.fetch = async (_, { headers }) => new Response(JSON.stringify({
    account_id: headers.Authorization.startsWith('Bearer x') ? 'remote-X' : 'remote-Y',
    rate_limit: { primary_window: { used_percent: 1 } }
  }));
  await f.run("pollAccount('a')");
  const base = await f.start();
  const cookie = await login(base);
  const patch = async body => {
    const response = await fetch(`${base}/api/accounts/a`, { method: 'PATCH', headers: { cookie }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await patch({ name: 'B', credentials: 'not json' })).status, 400);
  assert.equal(f.run('accounts[0].name'), 'A');

  const other = await patch({ credentials: JSON.stringify({ tokens: { access_token: 'y1', account_id: 'remote-Y' } }) });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'ACCOUNT_MISMATCH');
  assert.equal(f.run('readAuth(accounts[0]).token'), 'x1');

  // Without an account_id the swap only shows up upstream, where the kept binding still rejects it.
  assert.equal((await patch({ credentials: JSON.stringify({ access_token: 'y1' }) })).status, 200);
  await assert.rejects(f.run("pollAccount('a')"), /账号已变化/);
  assert.equal(f.run('accounts[0].remoteAccountId'), 'remote-X');
  assert.equal(f.run('snapshots.length'), 1);

  assert.equal((await patch({ name: 'B', credentials: JSON.stringify({ tokens: { access_token: 'x2', account_id: 'remote-X' } }) })).status, 200);
  await f.run("pollAccount('a')");
  assert.equal(f.run('snapshots.length'), 2);
  assert.equal(f.run('accounts[0].name'), 'B');
});

test('account summaries expose credential expiry and additional limits of the latest snapshot', t => {
  const f = fixture(t);
  const exp = Date.parse('2026-10-04T14:48:00.000Z') / 1000;
  const jwt = ['header', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'signature'].join('.');
  f.run(`accounts.push({ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'B', enabled: true });
    saveCredentials(accounts[0], { tokens: { access_token: '${jwt}' } });
    saveCredentials(accounts[1], { access_token: 'opaque-token' });
    snapshots.push({ accountId: 'a', capturedAt: '2026-01-01T00:00:00.000Z', raw: { additional_rate_limits: [
      { limit_name: 'Spark', rate_limit: { limit_reached: false, primary_window: { used_percent: 7, limit_window_seconds: 18000 } } },
      { limit_name: 'Broken', rate_limit: { primary_window: { used_percent: 'x' } } }
    ] } });`);
  const [a, b] = JSON.parse(f.run('JSON.stringify(accounts.map(accountSummary))'));
  assert.equal(a.credentialsExpiresAt, '2026-10-04T14:48:00.000Z');
  assert.equal(b.credentialsReady, true);
  assert.equal(b.credentialsExpiresAt, null);
  assert.equal(a.latest.raw, undefined);
  assert.deepEqual(a.latest.additional.map(item => [item.name, item.primary.usedPercent, item.secondary]), [['Spark', 7, null]]);
  assert.equal(b.latest, null);
});

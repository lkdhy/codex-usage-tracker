const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tracker-test-'));
  let server;
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
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
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
  for (const [body, status] of [['x'.repeat(1024 * 1024 + 1), 403], ['{', 403], ['null', 403]]) {
    const response = await fetch(`${base}/api/config`, { method: 'POST', body });
    assert.equal(response.status, status);
    await response.text();
  }
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/config`, { method: 'POST' }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    for (let i = 0; i < 17; i++) req.write(Buffer.alloc(65536, 120));
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(fs.existsSync(path.join(f.root, 'data/config.json')), false);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password: 'test-admin' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
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

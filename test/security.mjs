import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessAllowed, clientAddress, positiveLimit, reserveDaily } from '../server/security.mjs';

test('access password is explicit; forwarded headers cannot choose a limiter identity', () => {
  const key = 'fictional-test-only-not-a-credential';
  assert.equal(accessAllowed({ headers: {} }, key), false);
  assert.equal(accessAllowed({ headers: { 'x-zh-key': 'wrong' } }, key), false);
  assert.equal(accessAllowed({ headers: { 'x-zh-key': key } }, key), true);
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': 'forged' }, socket: { remoteAddress: 'actual' } }), 'actual');
  for (const value of [0, -1, 'NaN', 'Infinity', 1.5]) assert.throws(() => positiveLimit(value, 'test'));
});

test('paid attempt cap survives reload; corruption and concurrent lock fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soya-budget-'));
  const file = path.join(dir, 'usage.json');
  try {
    assert.equal(reserveDaily(file, 2), true);
    assert.equal(reserveDaily(file, 2), true);
    assert.equal(reserveDaily(file, 2), false);
    fs.writeFileSync(file, 'corrupt');
    assert.throws(() => reserveDaily(file, 2));
    fs.writeFileSync(file + '.lock', 'busy');
    assert.throws(() => reserveDaily(file, 2));
    fs.rmSync(file + '.lock');
    fs.writeFileSync(file, JSON.stringify({ day: '2020-01-01', used: 2 }));
    assert.equal(reserveDaily(file, 2), true);
    assert.equal(JSON.parse(fs.readFileSync(file)).used, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public HTML never discloses the password; unauthorized, malformed and throttled requests are rejected', async () => {
  const child = spawn(process.execPath, ['server/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MOCK_VISION: '1', API_ACCESS_KEY: 'fictional-test-only-not-a-credential', VISION_PER_MIN: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  let address;
  try {
    const deadline = Date.now() + 10000;
    while (!address && Date.now() < deadline) {
      const m = logs.match(/LISTENING (\d+)/);
      if (m) address = 'http://127.0.0.1:' + m[1];
      else await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(address, 'server must start');
    const html = await (await fetch(address)).text();
    assert.ok(!html.includes('fictional-test-only-not-a-credential'));
    assert.ok(!html.includes('__ZH_KEY'));
    for (const p of ['/server/.env', '/server/security.mjs', '/server/.runtime/vision.json', '/.git/config']) assert.equal((await fetch(address + p)).status, 404);
    const url = address + '/api/vision/detect';
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    const headers = { 'content-type': 'application/json', 'x-zh-key': 'fictional-test-only-not-a-credential' };
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-forwarded-for': 'one' }, body: JSON.stringify({ image: 'data:image/png;base64,AA==' }) })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-forwarded-for': 'two' }, body: JSON.stringify({ image: 'data:image/png;base64,AA==' }) })).status, 429);
    const sw = await fetch(address + '/js/sw.js');
    assert.equal(sw.headers.get('service-worker-allowed'), '/');
  } finally { child.kill(); await once(child, 'exit').catch(() => {}); }
});

test('real services cannot start without a strong access password', async () => {
  const child = spawn(process.execPath, ['server/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ZHIPU_API_KEY: 'synthetic-not-a-real-key', API_ACCESS_KEY: '', PORT: '0' }, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
});

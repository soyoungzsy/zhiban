// ============================================================
// test/run-all.mjs — 统一测试入口
// 运行：npm test  或  node test/run-all.mjs
// 每个测试文件在独立子进程中执行（内存状态互不污染）。
// ============================================================
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = ['security.mjs', 'data-layer.mjs', 'reliability.mjs', 'batch-data.mjs', 'batch-flow.mjs', 'weather.mjs', 'engine-space.mjs', 'health-rules.mjs', 'say-rules.mjs', 'add-input.mjs', 'dom-flow.mjs'];

const child = spawn(process.execPath, [path.join(dir, '../server/server.js')], {
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MOCK_VISION: '1', API_ACCESS_KEY: '', ZHIPU_API_KEY: '', QWEATHER_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const port = await new Promise((resolve, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error('mock startup timeout')), 10000);
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/LISTENING (\d+)/);
    if (match) { clearTimeout(timeout); resolve(match[1]); }
  });
  child.once('exit', () => { clearTimeout(timeout); reject(new Error('mock startup failed')); });
}).catch(error => { child.kill(); throw error; });
let failed = 0;
try {
  for (const t of tests) {
    console.log(t);
    const r = spawnSync(process.execPath, [path.join(dir, t)], {
      stdio: 'inherit', env: { ...process.env, ZHIBAN_TEST_BASE: 'http://127.0.0.1:' + port }
    });
    if (r.status !== 0) { failed++; console.log(t + ' 未通过'); }
  }
} finally { child.kill(); }
if (failed) { console.log('结果：' + failed + '个测试文件未通过'); process.exitCode = 1; }
else console.log('结果：全部' + tests.length + '个测试文件通过');

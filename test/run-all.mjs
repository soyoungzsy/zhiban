// ============================================================
// test/run-all.mjs — 统一测试入口
// 运行：npm test  或  node test/run-all.mjs
// 每个测试文件在独立子进程中执行（内存状态互不污染）。
// ============================================================
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = ['data-layer.mjs', 'reliability.mjs', 'batch-data.mjs', 'batch-flow.mjs', 'weather.mjs', 'engine-space.mjs', 'health-rules.mjs', 'say-rules.mjs', 'add-input.mjs', 'dom-flow.mjs'];

let failed = 0;
for (const t of tests) {
  console.log(`\n========== ${t} ==========`);
  const r = spawnSync('node', [path.join(dir, t)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`[${t}] 未通过`); }
}
console.log('\n========================================');
if (failed) { console.log(`结果：${failed} 个测试文件未通过`); process.exit(1); }
console.log(`结果：全部 ${tests.length} 个测试文件通过`);
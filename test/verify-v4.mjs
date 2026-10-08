// ============================================================
// test/verify-v4.mjs — v4 真实浏览器验证（第三批验收）
// 运行前提：MOCK_VISION=1 node server/server.js（端口 8438——同时托管静态）
// 运行：node test/verify-v4.mjs
//
// 覆盖（指令 §7.A/B/D）：
//   A 真键盘输入：逐字顺序（旧行为 cba 缺陷）、光标保持、中间插入、退格
//     ——真实 CDP 键盘事件；中文拼音选词需真机输入法（如实标注待复验）
//   B 批量建档全流程：真实照片上传→分析→mock 识别→删除误检→提交→
//     档案入库+局部图（Chrome canvas 真实裁剪）+ 原图共享
//   C 天气降级 UI：和风未配置时如实提示并回落内置表
// ============================================================
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8438';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT = 'screenshots';
fs.mkdirSync(SHOT, { recursive: true });   // 干净 clone 可直接跑：截图目录不存在则自建（不影响 .gitignore 排除）
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0; const fails = [];
const ok = (name, cond, note = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (note ? ' — ' + note : '')); }
};

// 1x1 测试照片（真实 PNG 文件用于 uploadFile）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 联通检查
try {
  const h = await (await fetch(BASE + '/api/health')).json();
  if (!h || h.vision.mode !== 'mock') { console.error('需要 MOCK_VISION=1 的 8438 代理在运行'); process.exit(2); }
} catch (e) { console.error('8438 代理未启动：先运行 MOCK_VISION=1 node server/server.js'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
async function fresh(hash, demo) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await p.goto(BASE + (demo ? '/?demo=1' : '/') + '#' + hash, { waitUntil: 'networkidle0' });
  return { ctx, p };
}
const waitText = (p, t, ms = 9000) =>
  p.waitForFunction(s => document.body && document.body.innerText.includes(s), { timeout: ms }, t).catch(() => null);
const pageText = p => p.evaluate(() => document.body.innerText);
const expand = async p => {
  await p.addStyleTag({ content: '.subpage{position:static!important;height:auto!important;max-height:none!important;overflow:visible!important}.tabbar,#view{display:none!important}' });
  await p.evaluate(() => scrollTo(0, 0));
};

/* ============ A. 真键盘输入（v4 §1 修复的实锤验证） ============ */
console.log('A 真键盘输入（#a-search）');
{
  const { ctx, p } = await fresh('/add', false);
  await waitText(p, '它是谁');
  const input = await p.$('#a-search');
  await input.focus();
  await p.keyboard.type('abc', { delay: 40 });        // 真实 CDP 键事件，逐字
  const v1 = await p.$eval('#a-search', el => el.value);
  ok('A1 连续键入 abc 得到 abc（修复旧行为 cba）', v1 === 'abc', 'value=' + v1);
  const sel1 = await p.$eval('#a-search', el => el.selectionStart);
  ok('A2 光标留在末尾（不再每次回 0）', sel1 === 3, 'selectionStart=' + sel1);
  await p.$eval('#a-search', el => el.setSelectionRange(2, 2));   // 光标移到 ab|c
  await p.keyboard.type('XY', { delay: 40 });
  const v2 = await p.$eval('#a-search', el => el.value);
  ok('A3 中间插入到光标处（abXYc）', v2 === 'abXYc', 'value=' + v2);
  await p.keyboard.press('Backspace');
  const v3 = await p.$eval('#a-search', el => el.value);
  ok('A4 退格删除光标前字符（abXc）', v3 === 'abXc', 'value=' + v3);
  const focused = await p.$eval('#a-search', el => document.activeElement === el);
  ok('A5 焦点全程保持（节点未重建）', focused === true);
  await p.$eval('#a-search', el => { el.value = '绿'; });
  await p.$eval('#a-search', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  await sleep(300);
  const cands = await p.$eval('#a-cands', el => el.textContent);
  ok('A6 输入后候选区局部更新', cands.includes('绿萝'), cands.slice(0, 30));
  console.log('  ⏸ 中文拼音组合选词需真实输入法——Chrome headless 无法真实模拟（合成事件不能冒充真机），真机复验项见 REVIEW_V4。');
  await p.screenshot({ path: `${SHOT}/v4-01-keyboard.png` });
  await ctx.close();
}

/* ============ B. 批量建档全流程（真实照片 → mock 识别 → 修正 → 提交） ============ */
console.log('B 批量建档全流程（演示模式识别）');
{
  const tmpPng = '/tmp/zhiban-v4-room.png';
  fs.writeFileSync(tmpPng, Buffer.from(PNG_B64, 'base64'));
  const { ctx, p } = await fresh('/batch', true);
  await waitText(p, '演示模式');
  const body0 = await pageText(p);
  ok('B0 演示模式明示"非真实识别"', body0.includes('演示模式') && body0.includes('不是真实识别'), body0.slice(0, 120));

  const file = await p.$('#b-file');
  await file.uploadFile(tmpPng);
  await waitText(p, '已加 1 张');
  await p.click('#b-detect');
  await waitText(p, '发现约');
  const t1 = await pageText(p);
  ok('B1 识别完成并如实摘要（约 2 盆可辨认 + 1 处待确认）', t1.includes('约 2 盆可辨认') && t1.includes('1 处待确认'), t1.slice(0, 160));
  const boxN = await p.$$eval('.bbox', els => els.length);
  ok('B2 原图渲染 3 个编号框', boxN === 3, 'bbox=' + boxN);
  ok('B3 候选卡含名称与把握分级', t1.includes('绿萝') && t1.includes('把握'));
  const cleanStore1 = await p.evaluate(() => JSON.parse(localStorage.getItem('zhiban:v1') || '{}'));
  const photoCount1 = Object.keys(cleanStore1.photos || {}).length;
  ok('B4 上传即存档原图（正式植物尚未建——草稿阶段不建档案）',
    photoCount1 === 7 /* demo 6 封面 + 1 张批次原图 */ && !(cleanStore1.plants || []).some(x => !x.isExample),
    'photos=' + photoCount1);

  // 删除待确认的第 3 处（误检示范）→ 摘要同步
  const rmBtn = await p.$$('[data-remove]');
  await rmBtn[2].click();
  await waitText(p, '已按误检删除');
  const t2 = await pageText(p);
  ok('B5 删除误检即时同步（剩约 2 盆 + 0 处待确认）', t2.includes('约 2 盆可辨认') && !t2.includes('1 处待确认'), t2.slice(0, 120));

  await expand(p); await sleep(250);
  await p.screenshot({ path: `${SHOT}/v4-02-batch-review.png`, fullPage: true });

  await p.click('#b-commit');
  const yes = await p.waitForSelector('.mask button[data-act="yes"]', { timeout: 5000 });
  ok('B6 提交前确认弹层（数量在按钮里写明）', !!(await pageText(p)).match(/建立所选 2 盆档案/));
  await yes.click();
  await waitText(p, '已建立');
  const t3 = await pageText(p);
  ok('B7 一批提交完成（2 盆）', t3.includes('已建立 2 盆档案'), t3.slice(0, 120));
  await p.screenshot({ path: `${SHOT}/v4-03-batch-done.png` });

  const stAfter = await p.evaluate(() => JSON.parse(localStorage.getItem('zhiban:v1')));
  const realPlants = (stAfter.plants || []).filter(x => !x.isExample);
  ok('B8 真实档案入库且不污染示例', realPlants.length === 2 && realPlants.every(x => x.name === '绿萝' || x.name === '多肉'),
    JSON.stringify(realPlants.map(x => x.name)));
  const eachHasCrop = realPlants.every(x => x.photoIds.length >= 2);
  ok('B9 每盆主图=局部图 + 共享原图（photoIds≥2；原图只存一份多盆复用）', eachHasCrop,
    JSON.stringify(realPlants.map(x => [x.name, x.photoIds.length])));
  const crops = Object.values(stAfter.photos || {}).filter(ph => ph && ph.region);
  ok('B10 局部图带来源标记（regionOf：原图+区域）', crops.length === 2 && crops.every(c => c.region.photoId && c.region.box),
    'crops=' + crops.length);
  ok('B11 建档后知识关联正确（绿萝→lvluo）', (realPlants.find(x => x.name === '绿萝') || {}).knowledgeKey === 'lvluo');
  await ctx.close();
}

/* ============ C. 天气降级 UI（和风未配置如实提示） ============ */
console.log('C 天气降级 UI');
{
  const { ctx, p } = await fresh('/spaces', true);
  await waitText(p, '修改城市');
  await p.click('#sp-city');
  await waitText(p, '直接搜城市名');
  await p.type('#f-q', '苏州');
  await p.click('#f-search');
  await waitText(p, '和风暂不可用');
  const t = await pageText(p);
  ok('C1 和风未配置如实提示并引导内置表（不冒充成功）', t.includes('和风暂不可用') && t.includes('未配置凭证'), t.slice(0, 200));
  await p.screenshot({ path: `${SHOT}/v4-04-city-fallback.png` });
  await ctx.close();
}

await browser.close();
console.log('');
console.log(`v4 真实浏览器验证：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
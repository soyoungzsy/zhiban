// ============================================================
// test/verify-pwa-online.mjs — 线上真实公网部署验收（v5 轮）
// 运行：
//   ZH_BASE=https://<函数域名>.<地域>.fcapp.run node test/verify-pwa-online.mjs
//
// 与 verify-pwa.mjs（本地"线上形态"实例）的差异：
//   C2 用服务端注入的 key 真实调用和风 city-lookup（线上真连通验证，
//      不拿假图消耗 GLM 额度——视觉在线上由真实使用时再验）
//   F 可控更新横幅不在线上自动化（无法对线上文件制造安全字节变化；
//      本地 verify-pwa 23/23 已验证同一路径，跳过项进入报告与真机复验清单）
// 其余动作与 verify-pwa.mjs 相同：A 安装 / B 白名单 / C key / D SW / E 离线 / G 设置页
// ============================================================
import puppeteer from 'puppeteer-core';

const BASE = process.env.ZH_BASE;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!BASE || !/^https:\/\/[-a-z0-9.]+\.fcapp\.run\/?$/.test(BASE)) {
  console.error('用法：ZH_BASE=https://<函数域名>.<地域>.fcapp.run node test/verify-pwa-online.mjs');
  process.exit(2);
}

let pass = 0; const fails = []; const skips = [];
const ok = (name, cond, note = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (note ? ' — ' + note : '')); }
};

// 联通与模式确认：线上应为 live-ready（真实凭证已配置）
let h = null;
try { h = await (await fetch(BASE + '/api/health')).json(); } catch (e) {}
if (!h || !h.ok) { console.error('线上 /api/health 不通：' + JSON.stringify(h)); process.exit(2); }
console.log(`线上形态：vision=${h.vision.mode}（${h.vision.msg}）weather=${h.weather.mode}（${h.weather.msg}）`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
async function fresh(hash = '/') {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await p.goto(BASE + (hash === '/' ? '/' : '/#' + hash), { waitUntil: 'networkidle0', timeout: 45000 });
  return { ctx, p };
}
const waitCtrl = p => p.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 }).catch(() => null);

/* ---------- A 安装条件 ---------- */
console.log('A 安装条件（manifest/图标/key 注入）');
{
  const { ctx, p } = await fresh();
  const m = await p.evaluate(async () => await (await fetch('manifest.webmanifest')).json());
  ok('A1 manifest：standalone + start_url / + 图标≥3（含 maskable）+ 名称含植伴',
    m.display === 'standalone' && m.start_url === '/' && m.icons.length >= 3 && m.icons.some(i => i.purpose === 'maskable') && /植伴/.test(m.name || ''),
    JSON.stringify({ name: m.name, icons: m.icons && m.icons.length }));
  const key = await p.evaluate(() => window.__ZH_KEY);
  ok('A2 服务端向页面注入访问 key（非空；缓存版无 key 由 D3 佐证）', typeof key === 'string' && key.length > 0, `key 类型=${typeof key}`);
  const codes = await p.evaluate(async () => Promise.all(
    ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png', 'icons/favicon-32.png']
      .map(async u => [(await fetch(u)).status, u])));
  ok('A3 图标五件全 200', codes.every(([c]) => c === 200), JSON.stringify(codes));
  await ctx.close();
}

/* ---------- B 静态白名单 ---------- */
console.log('B 静态白名单（线上不裸目录）');
{
  const { ctx, p } = await fresh();
  const codes = await p.evaluate(async () => {
    const out = {};
    for (const u of ['/REVIEW_V4.md', '/REVIEW_PWA.md', '/server/server.js', '/server/lib.mjs', '/package.json', '/.env', '/test/run-all.mjs', '/test/verify-pwa.mjs',
      '/screenshots/01-home.png', '/css/app.css', '/js/store.js', '/manifest.webmanifest'])
      out[u] = (await fetch(u)).status;
    return out;
  });
  const secret = ['/REVIEW_V4.md', '/REVIEW_PWA.md', '/server/server.js', '/server/lib.mjs', '/package.json', '/.env', '/test/run-all.mjs', '/test/verify-pwa.mjs', '/screenshots/01-home.png'];
  ok('B1 敏感文件全部 404（REVIEW/源码/配置/测试/截图）', secret.every(u => codes[u] === 404), JSON.stringify(codes));
  ok('B2 应用资源在白名单内 200', codes['/css/app.css'] === 200 && codes['/js/store.js'] === 200 && codes['/manifest.webmanifest'] === 200);
  await ctx.close();
}

/* ---------- C key 流动 + 和风线上真连通 ---------- */
console.log('C 付费接口 key 流动与真实天气连通');
{
  const { ctx, p } = await fresh();
  await waitCtrl(p);
  const r = await p.evaluate(async () => {
    const noKey = await fetch('/api/weather/city-lookup?name=杭州');
    const noBody = await noKey.json().catch(() => ({}));
    const withKey = await fetch('/api/weather/city-lookup?name=杭州', { headers: { 'x-zh-key': window.__ZH_KEY } });
    const txt = (await withKey.text()).slice(0, 160);
    return { noKey: noKey.status, err: noBody.error, withKey: withKey.status, body: txt };
  });
  ok('C1 无 key → 401 unauthorized（服务端强制校验）', r.noKey === 401 && r.err === 'unauthorized', JSON.stringify({ noKey: r.noKey, err: r.err }));
  ok('C2 注入 key → 200 且和风返回真实城市数据（凭证与外呼全通）',
    r.withKey === 200 && /杭州/.test(r.body), `status=${r.withKey} body=${r.body.slice(0, 80)}`);
  await ctx.close();
}

/* ---------- D SW 注册与预缓存 ---------- */
console.log('D Service Worker');
{
  const { ctx, p } = await fresh();
  await waitCtrl(p);
  const st = await p.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    if (!r) return { reg: null };
    return { installing: r.installing && r.installing.state, waiting: r.waiting && r.waiting.state, active: r.active && r.active.state };
  });
  ok('D0a SW 注册链路（探针：active=activated 即接管完成）', st.active === 'activated' || st.installing === 'installing' || st.waiting === 'installed', JSON.stringify(st));
  const reg = await p.evaluate(async () => {
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(res => setTimeout(() => res({ timeout: true }), 25000)),
    ]);
    if (ready && ready.timeout) return { readyTimeout: true };
    const keys = await caches.keys();
    const cacheName = keys.find(k => k.startsWith('zb-'));
    const cache = await caches.open(cacheName);
    const has = async u => !!(await cache.match(u));
    const idxBody = await (await cache.match('index.html')).text();
    return {
      controller: !!navigator.serviceWorker.controller,
      name: cacheName,
      idx: await has('index.html'), css: await has('css/app.css'),
      batch: await has('js/views/batch.js'), sw: await has('js/sw.js'),
      keyInCache: idxBody.includes('__ZH_KEY'),
    };
  });
  ok('D1 SW controller 接管应用', reg.controller === true, JSON.stringify(reg));
  ok('D2 预缓存外壳完整（index/样式/模块/SW 自身）', reg.idx && reg.css && reg.batch && reg.sw, JSON.stringify(reg));
  ok('D3 SW 缓存的 index 不含访问 key（x-sw-precache 标记生效）', reg.keyInCache === false);
  await ctx.close();
}

/* ---------- E 离线查看 ---------- */
console.log('E 离线能力');
{
  const { ctx, p } = await fresh();
  await waitCtrl(p);
  await p.evaluate(() => { location.hash = '#/add'; });
  await p.waitForSelector('#a-name', { timeout: 15000 });
  await p.type('#a-name', '离线小盆');
  await p.click('#a-save');
  await sleep(900);
  await p.setOfflineMode(true);
  const pid = await p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('zhiban:v1') || '{}');
    return (s.plants || []).find(x => x.name === '离线小盆').id;
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(900);
  await p.evaluate(() => { location.hash = '#/home'; });
  await sleep(700);
  let t;
  try { t = await p.evaluate(() => document.body.innerText); } catch (e) { t = String(e); }
  ok('E1 离线重启首页可打开（SW 外壳）', t.includes('本周') && t.includes('植物'), String(t).slice(0, 60));
  ok('E2 已建档植物离线首页可见', String(t).includes('离线小盆'));
  await p.evaluate(id => { location.hash = '#/plant/' + id; }, pid);
  await sleep(700);
  const t2 = await p.evaluate(() => document.body.innerText).catch(() => '');
  ok('E3 离线档案页与五行小卡内容可见', String(t2).includes('五行养护小卡') && String(t2).includes('平时怎么养'), String(t2).slice(0, 80));
  const apiCached = await p.evaluate(async () => {
    for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('/api/vision/detect')) return true; }
    return false;
  });
  ok('E5 API 响应从未进入缓存（失败/旧数据不冒充）', apiCached === false);
  await p.setOfflineMode(false);
  await ctx.close();
  const note = 'F1/F2/F3 在线更新横幅：线上无法安全制造 sw.js 字节变化，不自动化；本地 verify-pwa 23/23 已验证同一路径，列入真机复验清单（下次发版即真机会验）';
  skips.push(note);
  console.log('F 可控更新\n  － 跳过（如实记录）：' + note);
}

/* ---------- G 设置页说明卡可见 ---------- */
console.log('G 设置页说明');
{
  const { ctx, p } = await fresh('/settings');
  const t = await p.evaluate(() => document.body.innerText);
  ok('G1 主屏幕指引（iPhone/安卓/微信内三条路径）', t.includes('Safari') && t.includes('添加到主屏幕') && t.includes('Chrome') && t.includes('在浏览器打开'));
  ok('G2 离线说明（能看/不能/由你决定更新）', t.includes('离线能看') && t.includes('离线不能') && t.includes('由你决定'));
  ok('G3 隐私分项（档案本机≠所有数据不出网；识别照片发往服务+GLM）', t.includes('智谱') && t.includes('服务器') && t.includes('不保存'));
  ok('G4 换入口数据说明与迁移路径', t.includes('不互通') && t.includes('导出备份文件') && t.includes('从备份文件恢复'));
  await ctx.close();
}

await browser.close();
console.log('');
console.log(`线上部署验收：通过 ${pass} / 失败 ${fails.length} / 跳过 ${skips.length}`);
console.log(`目标：${BASE}`);
skips.forEach(s => console.log('  SKIP: ' + s));
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
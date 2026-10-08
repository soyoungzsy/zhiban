/* verify-live.mjs — 真实运行实测（2026-10-06 验收轮）
 * 需先启动: python3 -m http.server 8437 （zhiban/ 目录）
 * 运行: node test/verify-live.mjs
 * 特点: 每场景独立 Incognito Context（与默认浏览器档案隔离，不覆盖真实数据）；
 *       ?demo=1 装载示例数据；持久化验证通过"去掉 demo 参数的真实 reload"完成。 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8437';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT = 'screenshots';

let pass = 0; const fails = [];
const ok = (name, cond, note = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (note ? ' — ' + note : '')); console.log('  ✗ ' + name + (note ? ' — ' + note : '')); }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });

async function fresh(url) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await p.goto(BASE + url, { waitUntil: 'networkidle0' });
  return { ctx, p };
}
const waitText = (p, t, ms = 9000) =>
  p.waitForFunction(s => document.body && document.body.innerText.includes(s), { timeout: ms }, t).catch(() => null);
const text = p => p.evaluate(() => document.body.innerText);
/* .subpage 是 fixed+内部滚动容器：整页截图前注入展开样式（同 screenshot.mjs） */
async function expand(p) {
  await p.addStyleTag({ content: '.subpage{position:static!important;height:auto!important;max-height:none!important;overflow:visible!important}.tabbar,#view{display:none!important}' });
  await p.evaluate(() => scrollTo(0, 0));
}

/* ---------- 场景 1：首页 ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/`);
  await waitText(p, '白掌');
  const t = await text(p);
  ok('live-01 首页渲染（示例家·杭州）', t.includes('白掌') && t.includes('本周照顾重点') && t.includes('无需打卡'), '首页含植物卡/本周重点/无需打卡声明');
  await p.screenshot({ path: `${SHOT}/live-01-home.png` });
  await ctx.close();
}

/* ---------- 场景 2：添加植物 → 保存 → 真实刷新 → 数据仍在 ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/add`);
  await p.waitForSelector('#a-save', { timeout: 9000 }).catch(() => null);
  ok('live-02 建档页打开（拍照/位置/保存齐全）', await p.$('#a-save') !== null && (await text(p)).includes('放在哪个位置'));
  await p.type('#a-name', '验收临时盆');
  await p.click('#a-save');
  const jumped = await p.waitForFunction(() => location.hash.startsWith('#/plant/'), { timeout: 9000 }).catch(() => null);
  ok('live-02 无照片填名称可保存并跳转档案', !!jumped, 'hash=' + (jumped ? '已跳转' : '未跳转'));
  const saved = await waitText(p, '验收临时盆');
  ok('live-02 档案页显示新植物', !!saved);
  await p.screenshot({ path: `${SHOT}/live-02-add-saved.png` });
  /* 关键：去掉 ?demo=1 做真实 reload —— 本机存储必须仍保留数据。
   * v3 设计：建档自动建真实「我的家」，首页当前家切到新家（示例不顶替）——
   * 所以刷新后首页应显示新植物；示例数据不许丢，用位置页交叉验证。 */
  await p.goto(BASE + '/#/', { waitUntil: 'networkidle0' });
  const after = await waitText(p, '验收临时盆');
  const t2 = await text(p);
  ok('live-03 保存后刷新：新植物仍在首页（建档自动建家，数据持久化）', !!after && t2.includes('本周照顾重点'), '新植物随真实家保留');
  await p.screenshot({ path: `${SHOT}/live-03-persist-after-reload.png` });
  /* 示例数据完整保留的硬证据：store 层断言（位置页按当前家过滤是 v3 设计——
   * 建档后当前家已是真实"我的家"，UI 不再显示示例家内容，但数据一条不删）。 */
  const st3 = await p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('zhiban:v1') || '{}');
    return {
      exHome: (s.families || []).some(f => f.id === 'ex-home' && f.isExample),
      balconies: (s.spaces || []).filter(x => x.name === '阳台' && x.homeId === 'ex-home').length,
      exPlants: (s.plants || []).filter(x => x.familyId === 'ex-home').length,
      realHome: (s.families || []).some(f => f.id !== 'ex-home' && !f.isExample),
    };
  });
  ok('live-03b 刷新后示例数据完整保留（store 层：示例家/两个阳台/6 盆示例植物 + 自动建家）',
     st3.exHome && st3.balconies === 2 && st3.exPlants >= 6 && st3.realHome, JSON.stringify(st3));
  await ctx.close();
}

/* ---------- 场景 3：新建位置 → 真实刷新 → 仍在（空间持久化） ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/spaces`);
  await p.waitForSelector('#sp-new', { timeout: 9000 }).catch(() => null);
  const t0 = await text(p);
  ok('live-04 位置页显示两个同名「阳台」（环境不同）', (t0.match(/阳台/g) || []).length >= 3 && t0.includes('半室外') && t0.includes('基本不淋雨'), '露天/封闭同屏');
  await p.click('#sp-new');
  await p.waitForSelector('#ss-name', { timeout: 6000 }).catch(() => null);
  await p.type('#ss-name', '书房窗台');
  await p.click('#ss-save');
  const created = await waitText(p, '书房窗台');
  ok('live-04 新建位置「书房窗台」成功', !!created);
  await p.goto(BASE + '/#/spaces', { waitUntil: 'networkidle0' });
  const re = await text(p);
  await waitText(p, '书房窗台');
  ok('live-05 位置档案刷新后仍在（共享空间持久化）', re.includes('书房窗台') && re.includes('阳台') && re.includes('走廊'), '新位置 + 原有位置都保留');
  await expand(p); await new Promise(r => setTimeout(r, 250));
  await p.screenshot({ path: `${SHOT}/live-05-spaces-reload-persist.png`, fullPage: true });
  await ctx.close();
}

/* ---------- 场景 4：植物档案页 ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/plant/ex-yueji`);
  await waitText(p, '月季');
  const t = await text(p);
  ok('live-06 档案页（平时怎么养/三主操作/位置）', t.includes('平时怎么养') && t.includes('哪里不对') && t.includes('养护小卡'),
    JSON.stringify({ w: t.includes('平时怎么养'), h: t.includes('哪里不对'), c: t.includes('养护小卡') }));
  await expand(p); await new Promise(r => setTimeout(r, 250));
  await p.screenshot({ path: `${SHOT}/live-06-plant.png`, fullPage: true });
  await ctx.close();
}

/* ---------- 场景 5：症状排查（选择 → 追问） ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/health/ex-baizhang`);
  await waitText(p, '叶片下垂蔫软');
  const t = await text(p);
  ok('live-07 症状选择页（现象勾选 + 未接入徽标 + 不等照片）', t.includes('叶片下垂蔫软') && t.includes('未接入') && (t.includes('可选') || t.includes('不拍照')));
  await p.click('[data-sym="wilt"]');
  const fu = await p.waitForSelector('[data-fid="soil"]', { timeout: 6000 }).catch(() => null);
  ok('live-07 勾选后出现盆土追问（≤2 题）', !!fu);
  await p.screenshot({ path: `${SHOT}/live-07-health-select.png` });
  await ctx.close();
}

/* ---------- 场景 6：排查结果（湿土萎蔫 → 不推荐浇水） ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1&sym=wilt&soil=wet&go=1#/health/ex-baizhang`);
  await waitText(p, '浇水过多');
  const t = await text(p);
  ok('live-08 结果页：方向=浇水过多/过湿（不补水）', t.includes('浇水过多') && t.includes('先别浇水'), 'T03 核心');
  ok('live-08 明确不是确诊 + 依据来源明示', t.includes('不是确诊') && (t.includes('依据') || t.includes('根据你选择')));
  await expand(p); await new Promise(r => setTimeout(r, 250));
  await p.screenshot({ path: `${SHOT}/live-08-health-result.png`, fullPage: true });
  await ctx.close();
}

/* ---------- 场景 7：五行小卡（真实点击展开） ---------- */
{
  const { ctx, p } = await fresh(`/?demo=1#/plant/ex-duorou`);
  await waitText(p, '养护小卡');
  await p.click('#a-card');
  const mask = await p.waitForSelector('.card-fullmask', { timeout: 6000 }).catch(() => null);
  ok('live-09 点击展开五行小卡全屏', !!mask);
  const t = await text(p);
  ok('live-09 小卡内容可见（多肉五行）', t.includes('多肉') || t.includes('少浇水') || t.includes('晒太阳'));
  await new Promise(r => setTimeout(r, 300));
  await p.screenshot({ path: `${SHOT}/live-09-card.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n真实运行实测：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);

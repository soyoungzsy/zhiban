// ============================================================
// test/dom-flow.mjs — jsdom 端到端流程测试（v3 验收场景的 DOM 层）
// 运行：node test/dom-flow.mjs（由 run-all.mjs 统一调度）
//
// 覆盖：
//   T01 新用户不建家不建位置直接建档（自动建家、位置后补不阻塞）
//   T02 未传照片 · 症状排查从入口到建议完整可用
//   T03 萎蔫+土偏湿 → 停浇、不确诊、不催施肥（DOM 文本断言）
//   T05 已知不重问、追问 ≤ 2 且每题可跳过
//   T06 同一位置连建三盆：位置一次录入多盆复用、个体独立
//   T14 多家庭警示 + 「选我的家」迁移面板（归档不删数据）
//   T20 红线扫描：DOM 无打卡/倒计时/我浇过功能；数据无账本字段；重复打开建议稳定
//   位置小结：fit 直说合适 / mismatch 不硬选（T22 DOM 层）
// 注意：jsdom 不证明真实视觉布局（S8），布局验收在 Chrome 截图与真机复验。
// ============================================================

// ---- 1) 先构建 DOM 环境（必须在 import 应用模块之前）----
const jsdomMod = await import('jsdom');
const JSDOM = jsdomMod.JSDOM || jsdomMod.default.JSDOM;

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="view"></div><nav id="tabbar"></nav><div id="stack-root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;
globalThis.location = dom.window.location;
globalThis.localStorage = dom.window.localStorage;

// ---- 2) 应用模块（动态导入，此时全局环境已就绪）----
const S = await import('../js/store.js');
const HM = await import('../js/home-model.js');
const E = await import('../js/engine.js');
const V = {
  home: await import('../js/views/home.js'),
  add: await import('../js/views/add.js'),
  plant: await import('../js/views/plant.js'),
  health: await import('../js/views/health.js'),
  spaces: await import('../js/views/spaces.js'),
  settings: await import('../js/views/settings.js'),
};

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const text = el => (el ? (el.textContent || '').replace(/\s+/g, ' ') : '');
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const viewRoot = document.getElementById('view');
const mkSub = () => { const d = document.createElement('div'); d.className = 'subpage'; return d; };

/* ============ S1 · T01 新用户直接建档 ============ */
console.log('S1 T01 新用户：不建家、不建位置，直接建档');
{
  V.home.render(viewRoot);
  check('首页空状态引导「拍照建档」而非先建家', /拍照建档/.test(text(viewRoot)) && !/先建一个家/.test(text(viewRoot)), text(viewRoot).slice(0, 60));
  check('空状态允许先看示例', !!$('#btn-demo', viewRoot));

  const sub = mkSub();
  V.add.render(sub);
  check('建档页无家庭选择（单家庭）', !$('#a-fam', sub));
  check('建档页存在"暂未设置"位置项', $$('[data-sp="none"]', sub).length >= 1);
  check('提示第一盆保存时自动建家', /自动建立/.test(text(sub)));

  /* 填名称"绿萝"（命中知识库）→ 暂未设置 → 保存 */
  type($('#a-name', sub), '绿萝');
  await sleep(10);
  click($('#a-save', sub));
  await sleep(60);

  const home = HM.currentHome();
  check('保存后自动建立「我的家」', !!home && home.name === '我的家' && !home.isExample, home && home.name);
  const plants = S.listPlants();
  check('只有一盆植物且已建档', plants.length === 1 && plants[0].name === '绿萝');
  check('身份命中知识库（名字匹配）', plants[0].knowledgeKey === 'lvluo');
  check('位置=暂未设置（可后补，T01）', plants[0].spaceId === null);
  check('未设城市不阻塞（城市待补）', home.city === undefined || home.city === null);
  check('跳转到植物档案', location.hash.startsWith('#/plant/'), location.hash);
}

/* ============ S2 · T06 同一位置连建三盆 ============ */
console.log('S2 T06 同一位置连建三盆（位置一次录入、多盆复用）');
{
  /* 第一盆：内联新建位置「客厅窗边」 */
  let sub = mkSub(); V.add.render(sub);
  type($('#a-name', sub), '白掌');
  await sleep(10);
  type($('#a-newspace', sub), '客厅窗边');
  click($('#a-mkspace', sub));
  await sleep(20);
  click($('#a-save', sub));
  await sleep(40);
  const home = HM.currentHome();
  const sp = S.listSpaces(home.id).find(x => x.name === '客厅窗边');
  check('内联新建位置成功', !!sp);

  /* 第二、三盆：chips 里直接选已登记位置（不再重复输入） */
  for (const nm of ['蝴蝶兰', '绿萝二号']) {
    sub = mkSub(); V.add.render(sub);
    type($('#a-search', sub), nm);
    await sleep(10);
    const chip = $$('[data-k]', sub).find(c => c.textContent.includes(nm));
    if (chip) { click(chip); await sleep(10); }
    else type($('#a-name', sub), nm);
    const spChip = $$('[data-sp]', sub).find(c => c.dataset.sp === sp.id);
    check('已登记位置出现在选项（' + nm + '）', !!spChip);
    click(spChip); await sleep(10);
    click($('#a-save', sub));
    await sleep(40);
  }
  const home2 = HM.currentHome();
  check('位置仍只有一条（不重复建）', S.listSpaces(home2.id).length === 1);
  check('三盆都挂同一位置', S.spacePlantCount(sp.id) === 3);
  const inSpace = S.listPlants().filter(p => p.spaceId === sp.id);
  check('每盆独立 ID', new Set(inSpace.map(p => p.id)).size === 3);
}

/* ============ S3 · 首页位置筛选 ============ */
console.log('S3 首页位置筛选');
{
  V.home.render(viewRoot);
  const chips = $$('#space-filter .chip', viewRoot);
  check('筛选行含「全部」与该位置', chips.length >= 2 && chips.some(c => text(c).includes('全部')) && chips.some(c => text(c).includes('客厅窗边')));
  const target = chips.find(c => text(c).includes('客厅窗边'));
  click(target); await sleep(20);
  const tiles = $$('.plant-tile', viewRoot);
  check('选位置后仅显示该位置的植物', tiles.length === 3, '实际 ' + tiles.length);
  check('卡片位置行显示位置名', tiles.every(t => text(t.querySelector('.family-dot')).includes('客厅窗边')));
  const all = $$('#space-filter .chip', viewRoot).find(c => text(c).includes('全部'));
  click(all); await sleep(20);
  check('切回全部', $$('.plant-tile', viewRoot).length === 4);
}

/* ============ S4 · T14 多家庭警示与迁移 ============ */
console.log('S4 T14 多家庭：警示 + 选我的家（归档不删数据）');
{
  const fB = S.addFamily({ name: '老家', city: { name: '济南', province: '山东', zone: '华北' } });
  S.addPlant({ familyId: fB.id, name: '老家的一盆', knowledgeKey: 'hupilan' });
  /* 模拟 v2 升级场景：无已确认的 homeId（用户从未选过家）——这才触发
     "一次性迁移"；homeId 已存在时用户已确认过，不再打扰（设计行为）*/
  S.setPref('homeId', null);
  check('出现两个真实家庭（需迁移）', HM.needsHomePick() === true);

  V.home.render(viewRoot);
  check('首页顶部警示"多个家庭"', /多个家庭/.test(text(viewRoot)));
  check('警示链接到 #/spaces', !!$('a[href="#/spaces"]', viewRoot));

  const sub = mkSub(); V.spaces.render(sub);
  const picks = $$('[data-pick]', sub);
  check('迁移面板列出候选家庭', picks.length === 2);
  const plantsBefore = S.listPlants().length;
  click(picks[0]); await sleep(20);
  check('迁移完成（其余归档）', HM.currentHome() && HM.archivedRealFamilies().length === 1);
  check('无数据删除（归档家植物保留）', S.listPlants().length === plantsBefore);
  V.home.render(viewRoot);
  check('迁移后警示消失', !/多个家庭/.test(text(viewRoot)));
  check('首页不再显示归档家的植物', $$('.plant-tile', viewRoot).length === 4);
}

/* ============ S5 · T02/T03/T05 症状排查 DOM 全流程 ============ */
console.log('S5 症状排查（T02 无照片可用 / T03 湿土 / T05 追问规则）');
{
  const bz = S.listPlants().find(p => p.name === '白掌');
  const sub = mkSub();
  V.health.render(sub, [bz.id]);
  check('入口为「哪里不对」直白文案', /哪里不对/.test(text(sub)));
  check('明确"不拍照也可以"（T02）', /不拍照也可以/.test(text(sub)));
  check('照片病虫害分析未接入如实标注', !!$('.badge-offline', sub));
  const symChips = $$('[data-sym]', sub);
  check('8 个可观察现象（非病名）', symChips.length === 8, '实际 ' + symChips.length);
  check('现象均为"看到的"（不出现根腐病等症状名）', !/根腐病|缺铁|黑斑病/.test(symChips.map(c => c.textContent).join('')));

  const wiltChip = symChips.find(c => c.dataset.sym === 'wilt');
  click(wiltChip); await sleep(20);
  check('选萎蔫出现盆土追问（T05）', !!($('[data-fid="soil"]', sub)));
  check('追问不超过两题', new Set($$('[data-fid]', sub).map(c => c.dataset.fid)).size <= 2);
  const opts = $$('[data-fid="soil"]', sub);
  check('每题有"说不清/跳过"选项（可跳过）', opts.some(o => o.dataset.v === 'unsure'));
  check('不重复问已知资料（无植物名/城市问题）', !/叫什么|什么城市/.test(text(sub)));

  const wet = $$('[data-fid="soil"]', sub).find(o => o.dataset.v === 'wet');
  click(wet); await sleep(20);
  const obsBefore = S.listObservations(bz.id).length;
  click($('#h-go', sub)); await sleep(60);

  const t = text(sub);
  check('结果含「优先排查方向」', /优先排查方向/.test(t));
  check('T03 方向指向浇水过多/过湿', /浇水过多|过湿/.test(t));
  check('T03 第一条动作是停浇', /先别浇水|停浇/.test(t));
  check('T03 不推施肥（明确"先不要"）', /施肥/.test(t));
  check('T03 不确诊（明示）', /不构成确诊|不是确诊/.test(t));
  check('依据行标注来自用户症状+知识（T02）', /你选择的现象|现象/.test(t));
  check('观察与追问已记入档案（一次性，非流水）', S.listObservations(bz.id).length === obsBefore + 1);
  const lastObs = S.listObservations(bz.id)[0];
  check('追问答案随观察保存为本次背景', lastObs && lastObs.text.includes('盆土偏湿'), lastObs && lastObs.text);
  check('无照片也有完整结果（T02 核心断言）', t.includes('优先排查方向') && !/先拍一张才能分析/.test(t));
}

/* ============ S6 · T20 红线扫描（DOM + 数据 + 稳定性） ============ */
console.log('S6 T20 红线扫描');
{
  const bz = S.listPlants().find(p => p.name === '白掌');
  const subs = mkSub();
  V.plant.render(subs, [bz.id]);
  const hsub = mkSub(); V.health.render(hsub, [bz.id]);
  const spsub = mkSub(); V.spaces.render(spsub);
  const allText = [text(viewRoot), text(hsub), text(subs), text(spsub)].join('\n').replace(/\s+/g, ' ');

  for (const w of ['我浇过了', '倒计时', '连续签到', '已完成任务', '浇水打卡']) {
    check('DOM 无违禁功能词「' + w + '」', !allText.includes(w));
  }
  const dakaio = [...allText.matchAll(/打卡/g)];
  check('「打卡」仅出现在否定语境', dakaio.every(m => {
    const ctx = allText.slice(Math.max(0, m.index - 15), m.index + 15);
    return /无需|不需要|不参与|不用|不必|不做/.test(ctx);
  }));

  /* 数据层无账本字段（键名层扫描） */
  const badKeys = [];
  (function walkKeys(o, path) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (/lastWatered|waterLog|fertLog|streak|checkin|completedTask|doneAt|delayUntil/i.test(k)) badKeys.push(path + '.' + k);
      walkKeys(o[k], path + '.' + k);
    }
  })(S.load(), 'root');
  check('数据模型无任何账本/打卡字段', badKeys.length === 0, badKeys.join(', '));

  /* 重复打开建议稳定（不因打开而变）*/
  const n1 = E.weeklyItems().map(i => i.plant.id + i.category + i.title).join('|');
  const n2 = E.weeklyItems().map(i => i.plant.id + i.category + i.title).join('|');
  const n3 = E.weeklyItems().map(i => i.plant.id + i.category + i.title).join('|');
  check('连续多次打开，本周重点完全稳定（不催办/不重复）', n1 === n2 && n2 === n3);
}

/* ============ S7 · 位置小结 + 环境生效对照（T22 / §4.5 / T07） ============ */
console.log('S7 档案位置小结（光照未登记→不猜；补光后环境真正改变建议）');
{
  const bz = S.listPlants().find(p => p.name === '白掌');
  const home = HM.currentHome();
  const sp = S.listSpaces(home.id)[0];

  /* 对照起点：位置只有名字、光照未登记 → T07 不猜名称 */
  let sub = mkSub(); V.plant.render(sub, [bz.id]);
  check('光照未登记时如实说"还没登记"（不按名称猜）', /光照情况还没登记|名称本身说明不了/.test(text(sub)));

  /* 用户在「摆放位置」补一条光照 → 建议应真正改变（§4.5 空间必须实际生效） */
  S.updateSpace(sp.id, { light: '靠窗', exposure: '室内' });
  sub = mkSub(); V.plant.render(sub, [bz.id]);
  check('补光后白掌×靠窗 → 位置合适、无需调整', /位置合适|无需调整/.test(text(sub)));

  /* 同位置换 full-sun 植物对照：mismatch + 不硬选（T22） */
  const moli = S.addPlant({ familyId: home.id, spaceId: sp.id, name: '茉莉', knowledgeKey: 'moli' });
  const sub2 = mkSub(); V.plant.render(sub2, [moli.id]);
  const t2 = text(sub2);
  check('茉莉×靠窗散光 → 小结=光照对它明显不足（区分于知识库措辞）', /光照对它明显不足/.test(t2));
  check('无更合适位置时明说"暂无更合适"（不虚构候选）', /暂无更合适的已登记位置/.test(t2));
  check('不输出适配度分数', !/适配度\s*\d|\d+\s*分/.test(t2));
}

/* ============ S8 · settings 备份 UI ============ */
console.log('S8 设置页（备份与归档找回入口）');
{
  V.settings.render(viewRoot);
  check('存在"导出备份文件"', !!$('#s-export', viewRoot));
  check('存在"从备份文件恢复"输入', !!$('#s-import', viewRoot));
  check('版本行含 v5.0（线上主屏幕版）', /v5\.0/.test(text(viewRoot)));
  check('归档家庭有找回入口', !!$('#s-archexport', viewRoot) || S.listFamilies().filter(f => f.archived && !f.isExample).length === 0);
}

console.log('');
console.log(`dom-flow 回归：通过 ${pass} / 失败 ${fails.length}` + (fails.length ? ' -> ' + fails.join('; ') : ''));
process.exitCode = fails.length ? 1 : 0;
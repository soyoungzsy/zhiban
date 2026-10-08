// ============================================================
// test/add-input.mjs — 输入框与建档保存的 DOM 层回归（v4 §1 / §6.A）
// 运行：node test/add-input.mjs（由 run-all.mjs 统一调度）
//
// 覆盖：
//   I1 搜索输入：节点不被替换、焦点保持（a-search 全量重绘缺陷的逻辑层标志；
//      真实键盘光标/输入法全链路验收在浏览器与真机，见指令 §7.A）
//   I2 候选区局部更新、其余表单不被重建
//   I3 中文输入法组合期间候选不被拼音污染；组合结束后按正式文本刷新
//   I5 建档保存：写入失败不假成功、不跳转、草稿保留在页；恢复后可重试成功
//   S-corrupt 设置页出现「数据异常待处理」恢复入口（导出原件+确认清除）
// 说明：composition 为 jsdom 人工派发——合成事件不能冒充真机输入法测试，
//      本文件只断言"输入期间 DOM 不再被重建"这一结构性事实。
// ============================================================
const jsdomMod = await import('jsdom');
const JSDOM = jsdomMod.JSDOM || jsdomMod.default.JSDOM;
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="view"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;
globalThis.location = dom.window.location;
// quota 故障注入：jsdom 的 Storage 实例不允许覆盖 setItem —— 用包装对象
// （同 data-layer/reliability 的内存 mock 模式），jsdom 本体存为 realLS。
const realLS = dom.window.localStorage;
const KEY = 'zhiban:v1';
let quotaOn = false;
globalThis.localStorage = {
  getItem: k => realLS.getItem(k),
  setItem(k, v) {
    if (quotaOn && k === KEY) { const e = new Error('mock quota'); e.name = 'QuotaExceededError'; throw e; }
    realLS.setItem(k, v);
  },
  removeItem: k => realLS.removeItem(k),
};

const S = await import('../js/store.js');
const HM = await import('../js/home-model.js');
const V = { add: await import('../js/views/add.js'), settings: await import('../js/views/settings.js') };

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dispatch = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const viewRoot = document.getElementById('view');
if (!HM.ensureHome()) { console.error('造家失败'); process.exit(2); }

/* ---------- I1/I2：输入后节点不重建 ---------- */
console.log('I1 搜索输入节点稳定（不再每次输入整页重绘）');
V.add.render(viewRoot);
{
  const node0 = $('#a-search');
  if (!node0) console.error('!! #a-search 不存在');
  node0.focus();
  node0.value = '绿';
  dispatch(node0, 'input');
  await sleep(220);                        // 候选防抖 120ms
  const node1 = $('#a-search');
  check('I1 输入一次后输入框节点未被替换（同一引用）', node1 === node0);
  check('I1 焦点保持在输入框', document.activeElement === node0);
  const cands = $('#a-cands');
  check('I2 候选区局部更新且含「绿萝」', !!cands && cands.textContent.includes('绿萝'), cands && cands.textContent.slice(0, 40));
  check('I2 表单其余部分未被重建（拍照区标题仍在）', viewRoot.textContent.includes('拍张照片'));
}

/* ---------- I3：composition 组合不刷新候选 ---------- */
console.log('I3 输入法组合期间候选不被打断');
{
  const node = $('#a-search');
  const before = $('#a-cands').textContent;
  node.dispatchEvent(new window.CompositionEvent('compositionstart'));
  node.value = 'lvluo';                    // 拼音中间态
  dispatch(node, 'input');
  await sleep(220);
  check('I3 组合期间候选区不刷新（不被拼音状态污染）', $('#a-cands').textContent === before, $('#a-cands').textContent.slice(0, 30));
  node.value = '绿萝';
  node.dispatchEvent(new window.CompositionEvent('compositionend'));
  await sleep(220);
  const after = $('#a-cands').textContent;
  check('I3 组合结束后候选按正式文本刷新', after.includes('绿萝'), after.slice(0, 30));
}

/* ---------- I5：写入失败不假成功、可重试 ---------- */
console.log('I5 建档保存一致性（写入失败不假成功）');
{
  V.add.render(viewRoot);                  // 干净状态
  const nameEl = $('#a-name');
  nameEl.value = '配额下的盆';
  dispatch(nameEl, 'input');
  quotaOn = true;
  click($('#a-save'));
  await sleep(450);                        // async handler + finally draw
  check('I5 未跳转（仍停留建档页）', location.hash === '' || location.hash === '#/add', location.hash);
  check('I5 不出现「已建档」假成功', !document.body.textContent.includes('已建档'));
  check('I5 失败说明可见（还没真正存入）', document.body.textContent.includes('还没真正存入'));
  check('I5 草稿保留在页面（名称还在输入框）', ($('#a-name') || {}).value === '配额下的盆');
  check('I5 植物未入档（内存与持久层一致）', !S.listPlants().some(p => p.name === '配额下的盆'));
  quotaOn = false;
  click($('#a-save'));                     // draw 重建后的新按钮（已解除禁用）
  await sleep(450);
  check('I5 空间恢复后重试成功并跳转档案', location.hash.startsWith('#/plant/'), location.hash);
  check('I5 重试后植物确实入档', S.listPlants().some(p => p.name === '配额下的盆'));
}

/* ---------- S-corrupt：设置页损坏恢复入口 ---------- */
console.log('S-corrupt 设置页「数据异常」恢复入口');
{
  const s = S.load();
  s.__corrupt = { backupKey: 'zhiban:v1:corrupt:test', backedUp: true, at: Date.now(), message: 'SyntaxError: 测试' };
  realLS.setItem('zhiban:v1:corrupt:test', '{"original":"raw-data"}');
  const setRoot = document.createElement('div');
  document.body.appendChild(setRoot);
  V.settings.render(setRoot);
  const txt = setRoot.textContent;
  check('设置页出现「数据异常待处理」警示卡', txt.includes('数据异常'), txt.slice(0, 50));
  check('提供「导出损坏数据的原件」按钮', !!$('#s-corruptexport', setRoot));
  check('提供确认清除按钮（有备份时）', !!$('#s-corruptclear', setRoot));
  click($('#s-corruptclear', setRoot));
  await sleep(150);                        // confirmDlg 弹层出现
  const dlgOk = [...document.querySelectorAll('.mask button')].find(b => b.textContent.includes('已导出，清除'));
  check('清除必须过二次确认弹层', !!dlgOk);
  if (dlgOk) { click(dlgOk); await sleep(250); }
  check('确认后退出恢复态（corruptInfo 清空）', !S.corruptInfo(), JSON.stringify(S.corruptInfo()));
}

console.log('');
console.log(`add-input DOM 回归：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
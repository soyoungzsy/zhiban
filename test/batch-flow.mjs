// ============================================================
// test/batch-flow.mjs — 整屋批量建档流程（DOM 层，v4 §2）
// 运行：node test/batch-flow.mjs（需 8438 演示模式代理在跑：
//      MOCK_VISION=1 node server/server.js）
//
// 说明：jsdom 无 canvas（局部图裁剪在 Chrome 验收轮验证），本文件
// 通过真实草稿恢复路径进入评审页，验证勾选/删除/合并/改名/位置/提交
// 的全流程与幂等；识别网络链路经 8438 真实代理（fetch 存在）。
// ============================================================
const jsdomMod = await import('jsdom');
const JSDOM = jsdomMod.JSDOM || jsdomMod.default.JSDOM;
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="view"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;
globalThis.location = dom.window.location;
globalThis.__zhibanApiBase = 'http://127.0.0.1:8438';   // 真实代理（演示模式）
const realLS = dom.window.localStorage;
globalThis.localStorage = realLS;

const S = await import('../js/store.js');
const HM = await import('../js/home-model.js');
const V = { batch: await import('../js/views/batch.js') };

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const txt = root => (root || document).textContent.replace(/\s+/g, ' ');

const home = HM.ensureHome();
if (!home) { console.error('造家失败'); process.exit(2); }

/* 真实代理演示模式在跑？（fetch 海端连接） */
let health = null;
try { health = await (await fetch('http://127.0.0.1:8438/api/health')).json(); } catch (e) { health = null; }
check('BF0 8438 演示代理可达（vision.mode=mock 如实标注）', !!health && health.vision && health.vision.mode === 'mock', JSON.stringify(health && health.vision));

/* 造景：两张原图 + 四处检测（两组疑似重复、一处待确认、一处未选） */
const src0 = await S.savePhoto('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAE0', { forceId: 'bf-src-0' });
const src1 = await S.savePhoto('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAE1', { forceId: 'bf-src-1' });
const detections = [
  { detectionId: 'k1', photoIdx: 0, photoId: 'bf-src-0', box: { x: .1, y: .1, w: .3, h: .5 }, candidates: [{ name: '绿萝', confidence: 'high' }, { name: '心叶蔓绿绒', confidence: 'low' }], scene: ['靠窗'], selected: true, merged: false, removed: false, chosenName: '绿萝', chosenKey: null, spaceId: null, spaceDraft: '' },
  { detectionId: 'k2', photoIdx: 1, photoId: 'bf-src-1', box: { x: .12, y: .12, w: .29, h: .48 }, candidates: [{ name: '绿萝', confidence: 'medium' }], scene: [], selected: true, merged: false, removed: false, chosenName: '绿萝', chosenKey: null, spaceId: null, spaceDraft: '' },
  { detectionId: 'k3', photoIdx: 0, photoId: 'bf-src-0', box: { x: .6, y: .4, w: .2, h: .3 }, candidates: [], scene: [], selected: true, merged: false, removed: false, chosenName: '', chosenKey: null, spaceId: null, spaceDraft: '' },
  { detectionId: 'k4', photoIdx: 0, photoId: 'bf-src-0', box: { x: .2, y: .7, w: .1, h: .1 }, candidates: [], scene: [], selected: false, merged: false, removed: false, chosenName: '', chosenKey: null, spaceId: null, spaceDraft: '' },
];
S.saveBatchDraft({ homeId: home.id, photoIds: ['bf-src-0', 'bf-src-1'], done: [], detections });

const root = document.getElementById('view');
V.batch.render(root);
await sleep(300);   // health fetch 异步 draw

console.log('BF1 草稿恢复与评审渲染');
check('BF1 草稿恢复提示可见', txt(root).includes('已恢复上次的批次草稿'));
check('BF2 摘要从实际结果算：约 2 盆可辨认 + 2 处待确认', txt(root).includes('约 2 盆可辨认') && txt(root).includes('2 处待确认'), txt(root).slice(0, 160));
check('BF3 原图编号框渲染（4 处）', $$('.bbox', root).length === 4, String($$('.bbox', root).length));
check('BF4 疑似重复建议一对（k1×k2，可解释理由）', txt(root).includes('可能是同一盆') && !!$('[data-merge]', root));
check('BF5 提交按钮按当前勾选计（3 盆：未勾的 k4 不计）', !!$('#b-commit', root) && $('#b-commit', root).textContent.includes('3'), $('#b-commit', root) && $('#b-commit', root).textContent);

console.log('BF2 重复确认：用户确认合并');
{
  click($('[data-merge]', root));
  await sleep(50);
  check('BF6 合并后 k2 不再建且计数即时同步', txt(root).includes('已与另一处按') && txt(root).includes('不重复建'), txt(root).slice(0, 200));
  check('BF6b 摘要只剩 1 盆可辨认', txt(root).includes('约 1 盆可辨认'));
  check('BF6c 合并后计数减掉 k2（剩 k1+k3 两盆）', $('#b-commit', root) && $('#b-commit', root).textContent.includes('2'));
}

console.log('BF3 误检删除与恢复');
{
  const rm = $(`[data-remove="k3"]`, root);
  click(rm); await sleep(50);
  check('BF7 k3 按误检删除（摘要待确认减为 1）', txt(root).includes('已按误检删除') && txt(root).includes('1 处待确认'));
  const restore = $(`[data-restore="k3"]`, root);
  click(restore); await sleep(50);
  check('BF7b 恢复误删并回到候审', txt(root).includes('2 处待确认'));
}

console.log('BF4 候选名纠正（连知识库）');
{
  const k1card = $(`[data-det="k1"]`, root);
  click($('[data-cname="心叶蔓绿绒"]', k1card)); await sleep(50);
  const saved1 = S.loadBatchDraft().detections[0];       // 草稿持久后重读（loadBatchDraft 返回新树）
  check('BF8 库外候选名记录为手动名（不冒充知识库）', saved1.chosenName === '心叶蔓绿绒' && saved1.chosenKey === null, JSON.stringify({ n: saved1.chosenName, k: saved1.chosenKey }));
  click($('[data-cname="绿萝"]', k1card)); await sleep(50);
  check('BF8b 改回绿萝并关联知识库', S.loadBatchDraft().detections[0].chosenKey === 'lvluo');
}

console.log('BF5 位置草稿与选择');
{
  click($(`[data-togsel="k3"]`, root)); await sleep(50);   // 恢复的误检保持默认取消——不再建它
  const k3saved = S.loadBatchDraft().detections.find(x => x.detectionId === 'k3');   // 草稿持久后重读（同 BF8 教训）
  check('BF7c 恢复后又取消勾选（k3 不选）', k3saved.selected === false && $('#b-commit', root).textContent.includes('1'));
  click($(`[data-pickspace="k1"]`, root)); await sleep(50);
  const sheet = $('.sheet', document.body);
  check('BF9 位置选择抽屉打开（照片线索成中性草稿名）', !!sheet && txt(sheet).includes('窗边位置'), txt(sheet).slice(0, 120));
  const save = sheet && $('#bp-save', sheet);
  if (save) click(save);
  await sleep(50);
  check('BF9b 草稿名落位为"窗边位置A"（不猜房间用途）', S.loadBatchDraft().detections[0].spaceDraft === '窗边位置A', S.loadBatchDraft().detections[0].spaceDraft);
}

console.log('BF6 提交（confirm→幂等落库）');
{
  click($('#b-commit', root)); await sleep(100);
  const yes = $$('.mask button', document.body).find(b => b.dataset.act === 'yes');
  check('BF10 提交需确认弹层', !!yes);
  if (yes) click(yes);
  await sleep(600);
  check('BF11 提交完成（已建立 1 盆档案）', txt(root).includes('已建立 1 盆档案'), txt(root).slice(0, 180));
  const plants = S.listPlants();
  const created = plants.filter(p => p.name === '绿萝');
  check('BF12 建档名与位置正确（绿萝 · 窗边位置A 已建）', created.length === 1 && (S.getSpace(created[0].spaceId) || { name: null }).name === '窗边位置A', JSON.stringify(created.map(p => [p.name, p.spaceId])));
  check('BF13 原图共享挂载（photoIds 含存档原图）', created[0] && created[0].photoIds.includes('bf-src-0'), JSON.stringify(created[0] && created[0].photoIds));
  check('BF14 场景线索入 note（vision-scene）', created[0] && created[0].notes.some(n => n.tag === 'vision-scene' && n.text.includes('靠窗')));
  const draft = S.loadBatchDraft();
  check('BF15 草稿 done 记录（断点续传凭证，合并/未选不重建）', draft && draft.done.length === 1 && draft.done.includes('k1'), JSON.stringify(draft && draft.done));
  const plantCount = S.listPlants().filter(p => p.name === '绿萝').length;
  check('BF16 理由完整：位置只建一次（不以每盆重复建）', S.listSpaces(home.id).filter(sp => sp.name === '窗边位置A').length === 1);
}

console.log('');
console.log(`批量流程 DOM 回归：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
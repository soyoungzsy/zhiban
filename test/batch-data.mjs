// ============================================================
// test/batch-data.mjs — 批量建档数据层回归（v4 §2 / §5 坐标 / §6.A 幂等）
// 运行：node test/batch-data.mjs（由 run-all.mjs 统一调度）
//
// 覆盖：
//   LL 坐标具名转换顺序（GeoAPI=经度,纬度；天气路径=纬度/经度——指令硬要求）
//   VB/XJ  检测框校验（非法框丢弃）与模型 JSON 围栏提取
//   CD     批次草稿往返；幂等提交；中途容量失败只补失败项；原图复用
//   V      摘要从实际检测结果算（不信模型自报 count）；重复建议不自动合并
// ============================================================
import * as S from '../js/store.js';
import * as V from '../js/vision.js';
import * as LIB from '../server/lib.mjs';

const mem = {};
globalThis.localStorage = {
  getItem: k => (k in mem) ? mem[k] : null,
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};

const KEY = 'zhiban:v1';
let quotaOn = false;
const origSet = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = function (k, v) {
  if (quotaOn && k === KEY) { const e = new Error('mock quota'); e.name = 'QuotaExceededError'; throw e; }
  return origSet.call(this, k, v);
};

/* ---------- LL 坐标具名转换（v4 §5：字段转换+测试，不手写颠倒） ---------- */
console.log('LL 坐标转换顺序');
check('LL1 GeoAPI 查询串 = "经度,纬度"', LIB.lonLatForGeoLookup({ lon: 120.16, lat: 30.29 }) === '120.16,30.29', LIB.lonLatForGeoLookup({ lon: 120.16, lat: 30.29 }));
check('LL2 天气路径 = 纬度/经度', LIB.latLonForWeatherPath({ lat: 30.29, lon: 120.16 }) === '30.29/120.16', LIB.latLonForWeatherPath({ lat: 30.29, lon: 120.16 }));
check('LL3 坐标校验拒绝越界与非法值', LIB.validateLatLon({ lat: 91, lon: 120 }) === null && LIB.validateLatLon({ lat: 'x', lon: 120 }) === null && LIB.validateLatLon(null) === null);
check('LL4 合法坐标归一通过', JSON.stringify(LIB.validateLatLon({ lat: 30.29, lon: 120.16 })) === '{"lat":30.29,"lon":120.16}');

/* ---------- VB/XJ 检测框与 JSON 提取 ---------- */
console.log('VB/XJ 框校验与 JSON 提取');
check('VB1 非法框被拒（null/零宽/越界）', !LIB.validateBox(null) && !LIB.validateBox({ x: 0, y: 0, w: 0, h: 0 }) && !LIB.validateBox({ x: -0.5, y: 0, w: 0.3, h: 0.3 }) && !LIB.validateBox({ x: 0.8, y: 0, w: 0.4, h: 0.3 }));
check('VB2 合法框通过', LIB.validateBox({ x: 0.1, y: 0.1, w: 0.3, h: 0.4 }));
check('VB3 轻微越界 2% 容差通过', LIB.validateBox({ x: 0.99, y: 0, w: 0.02, h: 0.1 }) && LIB.validateBox({ x: 0, y: 0.99, w: 0.1, h: 0.02 }));
check('XJ1 围栏 JSON 提取', LIB.extractJson('说明如下```json\n{"a":1}\n```').a === 1);
check('XJ2 混杂文本中的裸 JSON 提取', LIB.extractJson('前缀 {"b":2} 后缀').b === 2);
check('XJ3 非 JSON 返回 null', LIB.extractJson('这里没有对象') === null);

/* ---------- CD 批次草稿与幂等提交 ---------- */
console.log('CD 批次草稿与幂等提交');
const fam = S.addFamily({ name: 'B家', city: { name: '杭州', province: '浙江', zone: '江南' } });
const src = await S.savePhoto('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', { forceId: 'src-photo-1' });
const draft = {
  homeId: fam.id, photoIds: [src.id], done: [],
  detections: [
    { detectionId: 'd1', photoId: src.id, box: { x: .08, y: .12, w: .3, h: .5 }, candidates: [{ name: '绿萝', confidence: 'high' }], selected: true, chosenName: '绿萝', chosenKey: 'lvluo', scene: ['靠窗', '落地放置'] },
    { detectionId: 'd2', photoId: src.id, box: { x: .44, y: .18, w: .24, h: .4 }, candidates: [{ name: '多肉', confidence: 'medium' }], selected: true, chosenName: '多肉', chosenKey: 'duorou' },
    { detectionId: 'd3', photoId: src.id, box: { x: .68, y: .34, w: .24, h: .46 }, candidates: [], selected: true },
    { detectionId: 'd4', photoId: src.id, box: { x: .2, y: .6, w: .1, h: .1 }, candidates: [], selected: false },
  ],
};
check('C1 草稿保存与读取往返', S.saveBatchDraft(draft) === true && S.loadBatchDraft().detections.length === 4);

const r1 = await S.commitBatch(draft);
check('D2 选中 3 建档、未选中不建', r1.ok === true && r1.created.length === 3 && S.listPlants().length === 3, JSON.stringify({ ok: r1.ok, created: r1.created.length, total: S.listPlants().length }));
const plants = S.listPlants();
check('D2b 原图复用：三盆共享同一 photoId（不为每盆重复存大图）', plants.every(p => p.photoIds.includes('src-photo-1')));
check('D2c 无候选区域建为待确认、不编名字', (() => { const p = plants.find(x => x.name === '待确认植物'); return !!p && p.identityPending === true && p.knowledgeKey === null; })());
check('D2d 场景线索如实入 note（vision-scene，视觉来源不冒充用户确认）', plants.find(x => x.name === '绿萝').notes.some(n => n.tag === 'vision-scene' && n.text.includes('靠窗')));
check('D2e 命名候选关联知识库', plants.find(x => x.name === '绿萝').knowledgeKey === 'lvluo');
S.saveBatchDraft(draft);
check('C2 提交后 done 标记落草稿（断点续传凭据）', S.loadBatchDraft().done.length === 3);
S.clearBatchDraft();
check('C3 清除草稿', S.loadBatchDraft() === null);

const r2 = await S.commitBatch(draft);
check('D3 幂等：重复提交不重建（done 跳过）', r2.created.length === 0 && S.listPlants().length === 3);

/* D4 中途容量失败 → 明确逐项状态 → 只补失败项 */
const draft2 = {
  homeId: fam.id, photoIds: [src.id], done: [],
  detections: [
    { detectionId: 'e1', photoIdx: 0, photoId: src.id, box: { x: .1, y: .1, w: .2, h: .2 }, candidates: [{ name: '茉莉', confidence: 'high' }], selected: true, chosenName: '茉莉', chosenKey: 'moli' },
    { detectionId: 'e2', photoIdx: 1, photoId: src.id, box: { x: .5, y: .5, w: .2, h: .2 }, candidates: [{ name: '白掌', confidence: 'medium' }], selected: true, chosenName: '白掌', chosenKey: 'baizhang' },
  ],
};
let nth = 0;
const r3 = await S.commitBatch(draft2, {
  onBefore: () => { nth++; if (nth === 2) quotaOn = true; },   // 第二盆开始时注入容量故障
});
const pidBefore = draft2.detections[1].plantId;
check('D4 中途失败：成功 1 / 失败 1 / done 只记成功项', r3.ok === false && r3.created.length === 1 && r3.failed.length === 1 && draft2.done.length === 1, JSON.stringify({ created: r3.created.length, failed: r3.failed.length, done: draft2.done.length }));
check('D4b 失败项已预生成稳定 plantId', typeof pidBefore === 'string');
check('D4c 持久层未被污染（只落了成功的茉莉）', S.listPlants().filter(p => p.name === '茉莉' || p.name === '白掌').length === 1);
quotaOn = false;
const r4 = await S.commitBatch(draft2);
check('D4d 解除故障后只补失败项（白掌唯一、总数 5）', r4.ok === true && r4.created.length === 1 && S.listPlants().filter(p => p.name === '白掌').length === 1 && S.listPlants().length === 5);
check('D4e 重试沿用同一预生成 plantId（不换目标）', draft2.detections[1].plantId === pidBefore && !!S.getPlant(pidBefore));

/* D5 用户确认"同盆合并"的重复才不建 */
const draft3 = { homeId: fam.id, photoIds: [src.id], done: [], detections: [
  { detectionId: 'f1', photoIdx: 0, photoId: src.id, box: { x: .1, y: .1, w: .1, h: .1 }, candidates: [{ name: '虎皮兰', confidence: 'high' }], selected: true, merged: true, chosenName: '虎皮兰' },
] };
const r5 = await S.commitBatch(draft3);
check('D5 已确认合并的重复不建（未确认则两盆独立，见 V2）', r5.ok === true && r5.created.length === 0 && S.listPlants().every(p => p.name !== '虎皮兰'));

/* ---------- V 摘要计数与重复建议（从实际结果计算，不自动合并） ---------- */
console.log('V 摘要与重复建议');
const sc = V.summarizeCounts([
  { candidates: [{ name: '绿萝', confidence: 'high' }] },
  { candidates: [{ name: '多肉', confidence: 'medium' }] },
  { candidates: [] },
  { candidates: [{ name: '疑似', confidence: 'low' }] },
  { candidates: [{ name: '吊兰', confidence: 'high' }], removed: true },
  { candidates: [{ name: '绿萝', confidence: 'high' }], merged: true },
]);
check('V1 摘要按实际结果算：high/medium 算辨认、low/无候选待确认、删/并跳过', sc.known === 2 && V.summarizeCounts([{ candidates: [] }, { candidates: [{ name: 'x', confidence: 'low' }] }]).pending === 2, JSON.stringify(sc));
const dA = { detectionId: 'a', photoIdx: 0, box: { x: .1, y: .1, w: .3, h: .5 }, candidates: [{ name: '绿萝', confidence: 'medium' }] };
const dB = { detectionId: 'b', photoIdx: 1, box: { x: .12, y: .12, w: .29, h: .48 }, candidates: [{ name: '绿萝', confidence: 'medium' }] };
const dC = { detectionId: 'c', photoIdx: 1, box: { x: .5, y: .4, w: .08, h: .1 }, candidates: [{ name: '绿萝', confidence: 'low' }] };
const dD = { detectionId: 'd', photoIdx: 0, box: { x: .6, y: .1, w: .3, h: .5 }, candidates: [{ name: '绿萝', confidence: 'medium' }] };
const hints = V.planDuplicateHints([dA, dB, dC, dD]);
check('V2 跨照片同名且大小相近 → 可解释建议（含"同一盆"由你确认）',
  hints.length === 2                                                       // a-b 与 b-d 两组都给出建议
  && hints.some(h => h.a === 'a' && h.b === 'b' && h.reason.includes('同一盆'))
  && hints.some(h => h.a === 'b' && h.b === 'd'),
  JSON.stringify(hints.map(h => h.a + '-' + h.b)));
check('V2b 大小差异大的不提示（不猜合并）', V.planDuplicateHints([dA, dC]).length === 0);
check('V2c 同一张照片内不提示（图内合并不做自动猜测）', V.planDuplicateHints([dA, dD]).length === 0);

console.log('');
console.log(`批量数据层回归：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
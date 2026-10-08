// ============================================================
// test/reliability.mjs — 保存一致性与损坏恢复回归（v4 §6.A / §6.B）
// 运行：node test/reliability.mjs（由 run-all.mjs 统一调度）
//
// 复现的故障（v4 审核包故障注入）：
//   R1 写入失败时 addPlant 仍返回新增对象（内存 2 盆 / 存储 1 盆不一致）
//   R2 updateSpace 修改失败不回滚
//   R3 setPref/addNote/addObservation 写失败静默
//   R4 load() 读到损坏 JSON 直接重置空态，后续迁移把空态写回覆盖原始数据
// 修复标准：可恢复提交——内存与持久层一致；失败不发布假成功；
//          损坏数据先备份进隔离键并提供导出/确认清除，绝不静默覆盖。
// ============================================================
import * as S from '../js/store.js';
import * as HM from '../js/home-model.js';

// ---- Node 无 localStorage：内存 mock（同 data-layer.mjs）----
const mem = {};
globalThis.localStorage = {
  getItem: k => (k in mem) ? mem[k] : null,
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
const KEY = 'zhiban:v1';

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};

/* ---- 故障注入工具：让主键写入抛 QuotaExceededError ---- */
let quotaOn = false;
const origSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = function (k, v) {
  if (quotaOn && k === KEY) {
    const e = new Error('mock: 本机存储空间不足');
    e.name = 'QuotaExceededError';
    throw e;
  }
  return origSetItem.call(this, k, v);
};

/* R0 正常路径回归：改造提交层后成功路径必须原样可用 */
console.log('R0 提交成功路径（回归）');
const fam = S.addFamily({ name: 'R家', city: { name: '杭州', province: '浙江', zone: '江南' } });
check('正常建家', !!fam);
const sp = S.addSpace({ homeId: fam.id, name: '测试位' });
check('正常建位置', !!sp);
const p0 = S.addPlant({ familyId: fam.id, name: '正常盆', knowledgeKey: 'lvluo' });
check('正常建植物并持久化', !!p0 && JSON.parse(mem[KEY]).plants.some(x => x.id === p0.id));
const up = S.updateSpace(sp.id, { note: '改一次' });
check('正常更新位置并持久化', !!up !== false ? JSON.parse(mem[KEY]).spaces.find(x => x.id === sp.id).note === '改一次' : false);
S.setPref('r0flag', 1);
check('setPref 成功持久化', JSON.parse(mem[KEY]).prefs.r0flag === 1);

/* R1 addPlant 写入失败：不返回新增对象、内存回滚、主键不污染 */
console.log('R1 addPlant 写入失败（配额注入）');
quotaOn = true;
const snapshot = mem[KEY];
const bad = S.addPlant({ familyId: fam.id, name: '应失败盆' });
check('addPlant 失败返回 null（不发布假成功）', bad === null, '返回了 ' + (bad && bad.name));
check('内存回滚：不再包含失败对象', !S.listPlants().some(x => x.name === '应失败盆'));
check('持久层未被污染', !JSON.parse(mem[KEY]).plants.some(x => x.name === '应失败盆'));
quotaOn = false;
const retry = S.addPlant({ familyId: fam.id, name: '重试盆' });
check('失败后解除注入可重试成功', !!retry && JSON.parse(mem[KEY]).plants.some(x => x.name === '重试盆'));

/* R2 updateSpace / updatePlant 写入失败回滚 */
console.log('R2 updateSpace/updatePlant 失败回滚');
S.updatePlant(p0.id, { spaceId: sp.id });            // 挂一盆到位置上（在配额注入前，供删除失败断言）
check('挂载后位置计数=1', S.spacePlantCount(sp.id) === 1);
quotaOn = true;
const nameBefore = S.getSpace(sp.id).name;
const r2a = S.updateSpace(sp.id, { name: '不应生效' });
check('updateSpace 失败返回 false', r2a === false, '返回 ' + r2a);
check('updateSpace 内存回滚', S.getSpace(sp.id).name === nameBefore);
const r2b = S.updatePlant(p0.id, { nickname: '不应生效昵称' });
check('updatePlant 失败返回 null', r2b === null);
check('updatePlant 内存回滚', S.getPlant(p0.id).nickname !== '不应生效昵称');
const r2c = S.addSpace({ homeId: fam.id, name: '建不出来的位置' });
check('addSpace 失败返回 null', r2c === null);
const r2d = S.addFamily({ name: '建不出来的家' });
check('addFamily 失败返回 null', r2d === null);
const r2e = S.addObservation({ plantId: p0.id, tags: ['wilt'], text: '写不进的观察' });
check('addObservation 失败返回 null', r2e === null);
check('addObservation 内存回滚', !S.listObservations(p0.id).some(o => o.text === '写不进的观察'));
const r2f = S.addNote(p0.id, '写不进的备注');
check('addNote 失败返回 null', r2f === null, '返回 ' + r2f);
check('addNote 内存回滚', !S.getPlant(p0.id).notes.some(n => n.text === '写不进的备注'));
S.setPref('不应写入', 1);
check('setPref 失败不生效', S.getPref('不应写入') === null);
check('deletePlant 失败返回 null 不误删', S.deletePlant(p0.id) === null && !!S.getPlant(p0.id));
const r2del = await S.deleteSpace(sp.id);   // deleteSpace 为 async（v3 起即如此）
check('deleteSpace 失败不影响植物与位置', r2del === null && !!S.getSpace(sp.id) && S.spacePlantCount(sp.id) === 1);
quotaOn = false;

/* R3 savePhoto：既有回滚语义在配额下保持（不静默丢图也不假成功） */
console.log('R3 savePhoto 配额下行为保持');
quotaOn = true;
let photoErr = null;
try { await S.savePhoto('data:image/png;base64,QUJD', {}); } catch (e) { photoErr = e; }
check('savePhoto 失败抛 PHOTO_SAVE_FAILED', photoErr && photoErr.code === 'PHOTO_SAVE_FAILED');
check('savePhoto 失败后照片元数据已回滚', !Object.values(S.load().photos).some(p => p.dataUrl === 'data:image/png;base64,QUJD'));
quotaOn = false;

/* R4 load() 损坏数据保护：先备份原样 → 恢复状态 → 确认后才清 */
console.log('R4 损坏 JSON 保护');
const badRaw = '{"plants":[{"id":"p1","familyId":"f1"';
mem[KEY] = badRaw;
S.reload();
const info = S.corruptInfo();
check('进入恢复状态（corruptInfo 可见）', !!info && !!info.backupKey);
check('原始损坏数据已原样备份进隔离键', mem[info.backupKey] === badRaw, '隔离键=' + mem[info.backupKey]);
check('load 本身不覆盖主键（原始仍在主键）', mem[KEY] === badRaw);
check('恢复态下应用可继续写入（新空态可 save）', (S.setPref('alive', 1), JSON.parse(mem[KEY]).prefs.alive === 1));
check('备份隔离键不受后续写入影响', mem[info.backupKey] === badRaw);
const exp = S.exportCorruptRaw(info.backupKey);
check('可导出损坏备份原文（供外部恢复）', exp === badRaw);
check('未确认清除被拒绝', S.clearCorrupt(info.backupKey) === false && S.clearCorrupt(info.backupKey, { confirm: false }) === false);
check('确认后清除并退出恢复态', S.clearCorrupt(info.backupKey, { confirm: true }) === true && !S.corruptInfo() && !(info.backupKey in mem));
const afterClean = JSON.parse(mem[KEY]);
check('清备份不清用户数据（保住新状态）', afterClean.prefs && afterClean.prefs.alive === 1);

console.log('');
console.log(`可靠性回归：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
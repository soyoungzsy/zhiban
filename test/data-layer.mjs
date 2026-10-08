// ============================================================
// test/data-layer.mjs — 数据层回归（v3 单家庭/空间/照片可靠性）
// 运行：node test/data-layer.mjs
// 覆盖 v3 场景：T13 迁移幂等不误并、T14 多家庭存档+删空间不删植物、
//              T19 保存失败可见旧数据不丢、备份导出导入往返。
// 说明：Node 环境无 IndexedDB → 照片自动走 local 降级模式，
//      属设计内路径；IDB 模式在真机另行验证（见 REVIEW_V3.md）。
// ============================================================
import * as S from '../js/store.js';
import * as HM from '../js/home-model.js';

// ---- 测试环境准备（Node 无 localStorage：内存 mock；无 IndexedDB 自动降级 local）----
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

/* D1 单家庭迁移（v3 §5） */
console.log('D1 单家庭迁移');
const fA = S.addFamily({ name: '家A', city: { name: '杭州', province: '浙江', zone: '江南' } });
const fB = S.addFamily({ name: '家B', city: { name: '济南', province: '山东', zone: '华北' } });
const pA = S.addPlant({ familyId: fA.id, name: '月季A', knowledgeKey: 'yueji' });
S.addPlant({ familyId: fB.id, name: '月季B', knowledgeKey: 'yueji' });
check('两个真实家庭需要选择', HM.needsHomePick() === true);
check('迁移候选列出两个', HM.homePickCandidates().length === 2);
const r1 = HM.pickHomeAndArchive(fA.id);
check('选择家A成功且归档 1 个', r1.ok && r1.archivedCount === 1, r1.msg);
check('当前家=家A', HM.currentHome().id === fA.id);
check('家B已归档但数据保留', S.getFamily(fB.id)?.archived === true && HM.archivedRealFamilies().length === 1);
check('重复执行不报错不重复归档', HM.pickHomeAndArchive(fA.id).ok === false);
let backup = HM.migrationBackupJSON();
check('迁移备份已生成（含两个家庭）', !!backup && JSON.parse(backup).families.length === 2);
const backupAgain = HM.migrationBackupJSON();
check('备份幂等不重复覆盖', backup === backupAgain);

/* D2 位置迁移（T06/T13：幂等 + 同文本合并、不同文本不合） */
console.log('D2 位置迁移');
S.updatePlant(pA.id, { env: { position: '阳台 · 花架', micro: '', tags: [] } });
const m1 = HM.migrateLegacyPositions();
check('首次迁移创建空间并关联', m1.created === 1 && m1.linked === 1, JSON.stringify(m1));
const m2 = HM.migrateLegacyPositions();
check('重复执行幂等跳过', m2.skipped === true);
check('植物 spaceId 已关联到同名空间', pA.spaceId === S.listSpaces(fA.id)[0].id);

/* D3 单家庭唯一化 + ensureHome（示例不污染城市） */
console.log('D3 单家庭唯一化');
check('唯一真实家庭自动绑定', HM.currentHome()?.id === fA.id);
check('ensureHome 直接复用不新建', HM.ensureHome().id === fA.id && S.listFamilies().filter(f => !f.archived).length === 1);
check('建档兜底不改变家庭城市', HM.currentHome().city.name === '杭州');

/* D4 空间 CRUD + 删除不删植物（T14） */
console.log('D4 空间 CRUD');
const sp = S.addSpace({ homeId: fA.id, name: '客厅窗边', exposure: '室内', light: '靠窗', note: '' });
check('addSpace 默认宽松字段（未知即空）', sp.rain === '未知' && sp.air === '' && sp.exposure === '室内');
const p2 = S.addPlant({ familyId: fA.id, name: '绿萝', knowledgeKey: 'lvluo', spaceId: sp.id });
check('新植物关联到空间', p2.spaceId === sp.id);
check('spacePlantCount 正确（只有绿萝在该空间）', S.spacePlantCount(sp.id) === 1);
const beforePlants = S.listPlants().length;
const del = await S.deleteSpace(sp.id);
check('删空间：植物移入暂未设置且不删植物', del.moved === 1 && p2.spaceId === null && S.listPlants().length === beforePlants);
check('同名空间允许并存（T08 前置数据能力）', (() => {
  S.addSpace({ homeId: fA.id, name: '阳台', rain: '会淋雨', exposure: '半室外' });
  S.addSpace({ homeId: fA.id, name: '阳台', rain: '基本不淋雨', exposure: '室内', note: '封闭窗台' });
  const same = S.listSpaces(fA.id).filter(x => x.name === '阳台');
  return same.length === 2 && same[0].id !== same[1].id && same[0].rain !== same[1].rain;
})());

/* D5 照片 local 降级模式（local 模式=设计内路径） */
console.log('D5 照片（降级模式）');
const ph = await S.savePhoto('data:image/png;base64,xxxx', { oldPhoto: false });
const back = await S.getPhoto(ph.id);
check('local 模式存取一致', back?.dataUrl === 'data:image/png;base64,xxxx');
check('local 模式迁移幂等跳过', (await S.migratePhotosToIDBOnce()).skipped === true);
await S.detachPhoto(ph.id);
check('detachPhoto 清理干净', (await S.getPhoto(ph.id)) === null);

/* D6 备份导出导入往返（7.4 简单完整备份） */
console.log('D6 备份往返');
const plantCount = S.listPlants().length;
const exported = await HM.exportAll();
const eo = JSON.parse(exported);
check('导出结构有效（zhiban 标记+家庭+植物）', eo.zhiban === true && eo.state.families.length === 2 && eo.state.plants.length === plantCount);
S.addPlant({ familyId: fA.id, name: '多余的一盆' });
const imp = await HM.importAll(exported);
check('导入恢复成功', imp.ok, imp.msg);
check('恢复后植物数与导出一致', S.listPlants().length === plantCount);
check('归档家庭在恢复后仍归档', S.getFamily(fB.id)?.archived === true);

/* D7 容量失败可见（T19 预演） */
console.log('D7 容量失败可见');
let hookCalled = 0;
globalThis.__zhibanSaveFailHook = () => { hookCalled++; };
const rawSet = globalThis.localStorage.setItem.bind(globalThis.localStorage);
globalThis.localStorage.setItem = (k, v) => { if (k === 'zhiban:v1') throw new Error('QuotaExceededError'); rawSet(k, v); };
const savedOK = S.save();
globalThis.localStorage.setItem = rawSet;
check('写入失败返回 false（不显示成功）', savedOK === false);
check('失败钩子可见（toast 挂接点）', hookCalled >= 1);
check('失败后 history 未丢（localStorage 原值未动）', JSON.parse(globalThis.localStorage.getItem('zhiban:v1') || '{}').plants.length === plantCount);
// savePhoto 回滚的确定性验证（await，禁用恒真占位——v3 不接受凑数断言）
{
  globalThis.localStorage.setItem = (k, v) => { if (k === 'zhiban:v1') throw new Error('QuotaExceededError'); rawSet(k, v); };
  const beforeKeys = Object.keys(S.load().photos).length;
  let threw = false;
  try { await S.savePhoto('data:image/png;base64,yyyy'); } catch (e) { threw = e.code === 'PHOTO_SAVE_FAILED'; }
  globalThis.localStorage.setItem = rawSet;
  check('savePhoto 失败回滚不丢原数据', threw && Object.keys(S.load().photos).length === beforeKeys);
}

console.log('');
console.log(`数据层回归：通过 ${pass} 项 / 失败 ${fails.length} 项` + (fails.length ? ' -> ' + fails.join('; ') : ''));
process.exitCode = fails.length ? 1 : 0;
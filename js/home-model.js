// ============================================================
// home-model.js — 单家庭收敛（v3 第 5 节）
//
// 原则：
//   · 取消多家庭的用户操作（选择/切换/新增/邀请），首页即自家；
//   · 底层 families 数据保留（v3：不为删字段破坏兼容），归档
//     家庭的数据原样保留在"迁移存档"中，可导出找回，绝不擅自删除；
//   · 仅一个真实家庭 → 自动绑定；只有示例家庭 → 示例仅作展示，
//     不绑定、也不让示例决定用户城市；多个真实家庭 → 必须用户
//     显式选择（生成迁移说明 + 一次性备份后归档其余）；
//   · 迁移幂等：备份只写一次，重复执行不产生重复家庭/空间。
//
// 本模块不渲染任何 UI，页面（spaces.js / settings.js / home.js）
// 调用这些函数并根据返回值渲染。
// ============================================================

import * as store from './store.js';

const BACKUP_KEY = 'zhiban:backup-single-home';   // 单家庭迁移前的一次性备份

/* ---------------- 查询 ---------------- */

/** 未归档的真实（非示例）家庭 */
export function liveRealFamilies() {
  return store.listFamilies().filter(f => !f.archived && !f.isExample);
}

/** 已归档的真实家庭（迁移存档，可找回） */
export function archivedRealFamilies() {
  return store.listFamilies().filter(f => f.archived && !f.isExample);
}

/**
 * 当前家（单家庭）：
 *   唯一真实家庭 → 自动绑定并返回；
 *   仅示例家庭   → 返回示例（仅作演示视图，不绑定 homeId）；
 *   0 个或 ≥2 个真实家庭 → null（由页面渲染引导/迁移选择）。
 */
export function currentHome() {
  const pref = store.getPref('homeId', null);
  if (pref) {
    const f = store.getFamily(pref);
    if (f && !f.archived) return f;
  }
  const real = liveRealFamilies();
  if (real.length === 1) {
    store.setPref('homeId', real[0].id);
    return real[0];
  }
  if (real.length === 0) {
    const ex = store.listFamilies().filter(f => f.isExample && !f.archived);
    const live = store.listFamilies().filter(f => !f.archived);
    // 只有示例（或没有任何家庭）时：示例可作演示视图；完全没有则 null
    if (live.length === 1 && live[0].isExample) return live[0];
    return null;
  }
  return null; // ≥2 真实家庭：等待用户确认
}

/** 是否需要弹出"选择我的家"迁移确认（≥2 真实家庭未选时为 true） */
export function needsHomePick() {
  return liveRealFamilies().length > 1 && currentHome() === null;
}

/** 需要先选择家的候选清单（渲染迁移面板用） */
export function homePickCandidates() {
  return liveRealFamilies().map(f => ({
    id: f.id, name: f.name, city: f.city ? f.city.name : null,
    plants: store.listPlants().filter(p => p.familyId === f.id).length,
  }));
}

/* ---------------- 迁移 ---------------- */

/**
 * 一次性迁移：把所选家庭设为「我的家」，其余真实家庭归档保留。
 * 失败宁可中止：
 *   - 备份写不进去 → 直接中止（原数据未动）；
 *   - 幂等：BACKUP_KEY 已存在则不再覆盖。
 */
export function pickHomeAndArchive(chosenId) {
  const all = liveRealFamilies();
  if (all.length <= 1) return { ok: false, msg: '当前只有一个真实家庭，不需要迁移。' };
  const chosen = all.find(f => f.id === chosenId);
  if (!chosen) return { ok: false, msg: '所选家庭不存在或已归档。' };
  try {
    if (!localStorage.getItem(BACKUP_KEY)) {
      const snapshot = localStorage.getItem('zhiban:v1') || '{}';
      localStorage.setItem(BACKUP_KEY, snapshot);
    }
  } catch (e) {
    return { ok: false, msg: '迁移备份写入失败，已中止（你的数据没有被改动）。' };
  }
  let archivedCount = 0;
  for (const f of all) {
    if (f.id !== chosenId) {
      store.updateFamily(f.id, { archived: true, archivedAt: Date.now() });
      archivedCount++;
    }
  }
  store.setPref('homeId', chosenId);
  return {
    ok: true, archivedCount,
    msg: `已把「${chosen.name}」设为我的家，其余 ${archivedCount} 个家庭已归档保留（不显示，但数据完整，可在设置页导出找回）。`,
  };
}

/** 导出迁移前的完整备份 JSON（可找回归档家庭数据） */
export function migrationBackupJSON() {
  return localStorage.getItem(BACKUP_KEY) || null;
}

/* ---------------- 建档用兜底 ---------------- */

/**
 * 确保"我的家"存在（建档/添加位置等流程调用）：
 *   有真实家 → 返回它（示例家庭不顶替真实家）；
 *   当前是示例 → 首次真实建档时新家「我的家」并设为当前（城市为空，
 *                不被示例城市污染），示例保留可随时清除；
 *   无家 → 新建「我的家」（城市参数仅为用户显式设置时传入，默认空）。
 * 注意：需要选择家时返回 null，调用方应渲染迁移面板而不是替用户决定。
 */
export function ensureHome(city = null) {
  const home = currentHome();
  if (home && home.isExample) {
    const real = liveRealFamilies();
    if (real.length > 0) {
      store.setPref('homeId', real[0].id);
      return real[0];
    }
    const nue = store.addFamily({ name: '我的家', city: city || null, isExample: false });
    if (!nue) return null;                    // v4：新建家写入失败时返回 null，不假成功
    store.setPref('homeId', nue.id);
    return nue;
  }
  if (home) return home;
  if (needsHomePick()) return null;
  const nue = store.addFamily({ name: '我的家', city: city || null, isExample: false });
  if (!nue) return null;
  store.setPref('homeId', nue.id);
  return nue;
}

/**
 * 旧位置文字 → 共享空间的一次性迁移（v3 T06/T13）：
 *   - 幂等（spaceMigrated 标记，重复执行不再生成）；
 *   - 只迁移当前家植物（归档家庭数据不动）；
 *   - 仅"完全相同的位置文本"合为同一空间（不同文本绝不合并）；
 *   - 新空间环境字段一律"未知"，等用户主动补充——绝不按名字推断（T07）。
 */
export function migrateLegacyPositions() {
  if (store.getPref('spaceMigrated', false)) return { skipped: true };
  const home = currentHome();
  if (!home) return { skipped: true };
  let created = 0, linked = 0;
  for (const p of store.listPlants()) {
    if (p.familyId !== home.id) continue;
    if (p.spaceId == null && p.env && p.env.position && p.env.position.trim()) {
      const pos = p.env.position.trim();
      let sp = store.listSpaces(home.id).find(x => x.name === pos);
      if (!sp) { sp = store.addSpace({ homeId: home.id, name: pos }); created++; }
      store.updatePlant(p.id, { spaceId: sp.id });
      linked++;
    }
  }
  store.setPref('spaceMigrated', true);
  return { created, linked };
}

/** 全量应用数据导出（备份用）：含照片数据（IDB/local 二态聚合） */
export async function exportAll() {
  const state = JSON.parse(localStorage.getItem('zhiban:v1') || '{}');
  // IDB 模式下照片数据不在 localStorage —— 聚合进导出文件
  const { allPhotoBlobs } = await import('./db.js');
  const blobs = await allPhotoBlobs();
  const photos = {};
  for (const [id, meta] of Object.entries(state.photos || {})) {
    photos[id] = { ...meta, dataUrl: blobs[id] || meta.dataUrl || null };
  }
  return JSON.stringify({ zhiban: true, version: 3, exportedAt: Date.now(), state: { ...state, photos } }, null, 2);
}

/** 备份导入（恢复）：整体覆盖并写回照片数据（含确认弹层文案由调用方展示） */
export async function importAll(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch (e) { return { ok: false, msg: '文件不是有效的植伴随份。' }; }
  if (!data || !data.zhiban || !data.state) return { ok: false, msg: '这份文件缺少植伴随份标记，无法导入。' };
  const incoming = data.state;
  if (!Array.isArray(incoming.families) || !Array.isArray(incoming.plants)) {
    return { ok: false, msg: '备份数据结构不完整。' };
  }
  // 导入前先把现有数据在同 key 旁留一份（可再次恢复）
  try {
    const current = localStorage.getItem('zhiban:v1');
    if (current) localStorage.setItem('zhiban:backup-before-import', current);
  } catch (e) { /* 留不下也继续：导入本身是用户显式动作 */ }
  localStorage.setItem('zhiban:v1', JSON.stringify(incoming));
  // 写回照片 blob
  const { clearPhotoBlobs, putPhotoBlob } = await import('./db.js');
  await clearPhotoBlobs();
  const dbmode = (await import('./db.js')).dbMode();
  let photosRestored = 0;
  for (const [id, meta] of Object.entries(incoming.photos || {})) {
    if (meta && meta.dataUrl) {
      if (dbmode === 'idb') { try { await putPhotoBlob(id, meta.dataUrl); photosRestored++; } catch (e) {} }
      else photosRestored++;
    }
  }
  store.reload();
  return { ok: true, msg: `已恢复备份：${incoming.families.length} 个家庭、${incoming.plants.length} 盆植物、${photosRestored} 张照片。` };
}
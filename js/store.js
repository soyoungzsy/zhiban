// ============================================================
// store.js — 数据层
//
// 设计约定（对应需求红线）：
// 1. 实体：家庭 / 植物 / 照片 / 观察（变化）/ 背景备注。
//    其中「观察」只在植物出现变化（花苞、黄叶、开花等）时产生，
//    是"变化记录"而非"操作流水"。
// 2. 数据模型中不存在：逐次浇水记录、用水量、打卡、任务、
//    延期、倒计时、连续天数、"我浇过了"等任何字段。
//    系统永远不记录"用户什么时候浇过水"。
// 3. 信息按来源分别保存：'user'（用户明确提供）/ 'photo'（照片观察）
//    / 'infer'（系统推测）。推测永远不覆盖用户事实。
// 4. 全部数据仅保存在本设备浏览器 localStorage。
// ============================================================

import { putPhotoBlob, getPhotoBlob, delPhotoBlob, dbMode } from './db.js';

const KEY = 'zhiban:v1';

let state = null;

function blank() {
  return {
    families: [],   // {id, name, city:{name, province, zone}, colorIdx, isExample?, createdAt}
    plants: [],     // 见 newPlant()；spaceId 关联摆放位置（null=暂未设置）
    spaces: [],    // 轻量摆放位置档案（v3 §4）：{id, homeId, name, exposure, light, air, rain, note, createdAt, updatedAt}
    observations: [], // {id, plantId, photoId?, tags:[], text?, source:'photo'|'user', uncertain?, isCurrentState, stateAt, createdAt}
    photos: {},    // id -> {id, dataUrl, capturedAt?（照片自身时间估计）, oldPhoto, createdAt}
    prefs: {},     // {activeFamilyFilter:'all'|id, lastAddFamilyId}
  };
}

export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : blank();
    // 归一化（跨版本兼容）：spaces 实体、植物位置关联、个体差异字段
    if (!state.spaces) state.spaces = [];
    for (const p of state.plants) {
      if (p.spaceId === undefined) p.spaceId = null;
      if (p.env && p.env.micro === undefined) p.env.micro = '';
    }
    // 单家庭化：archived 字段兜底
    for (const f of state.families) if (f.archived === undefined) f.archived = false;
  } catch (e) {
    // v4 §6.B：损坏 JSON 绝不再“静默重置、随后被迁移写回覆盖原始数据”。
    // 原样备份进隔离键 → 进入恢复状态；设置页可导出，用户确认后才允许清除。
    let rawSaved = null;
    try { rawSaved = localStorage.getItem(KEY); } catch (e0) { rawSaved = null; }
    const backupKey = KEY + ':corrupt:' + Date.now();
    let backedUp = false;
    try { if (rawSaved != null) { localStorage.setItem(backupKey, rawSaved); backedUp = true; } } catch (e2) { backedUp = false; }
    console.warn('数据读取失败：已原样备份并进入恢复状态（设置页可导出损坏备份）', e);
    state = blank();
    state.__corrupt = { backupKey, backedUp, at: Date.now(), message: String(e && e.message || e) };
  }
  return state;
}

export let lastSaveFailed = false;

/** 丢弃内存缓存，强制从 localStorage 重读（备份导入后调用） */
export function reload() {
  state = null;
  return load();
}

let _lastGood = undefined;

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    lastSaveFailed = false;
    return true;
  } catch (e) {
    lastSaveFailed = true;
    console.error('保存失败（本机存储空间可能已满）', e);
    // 全局可见钩子（main.js 挂接 toast），存储失败永远可见，不静默显示成功
    if (typeof globalThis !== 'undefined' && globalThis.__zhibanSaveFailHook) {
      try { globalThis.__zhibanSaveFailHook(); } catch (_) {}
    }
    return false;
  }
}

/* ---------------- 事务提交（v4 §6.A：内存与持久层一致）----------------
   所有写函数统一走 commit：mutate 修改内存 → 原子写主键；
   写失败时内存回滚到快照（并尽力把旧快照写回），调用端拿到明确的成功/失败，
   不再出现“内存 2 盆、存储 1 盆”或“addPlant 失败仍返回新增对象”的假成功。 */
function commit(mutate) {
  const snapStr = JSON.stringify(load());
  let out;
  try {
    out = mutate(load());
  } catch (mutErr) {
    console.error('状态修改异常，已回滚未提交', mutErr);
    try { state = JSON.parse(snapStr); } catch (e) { state = null; }
    return { ok: false, result: undefined };
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
    lastSaveFailed = false;
    return { ok: true, result: out };
  } catch (writeErr) {
    lastSaveFailed = true;
    console.error('保存失败（本机存储空间可能已满）', writeErr);
    if (typeof globalThis !== 'undefined' && globalThis.__zhibanSaveFailHook) {
      try { globalThis.__zhibanSaveFailHook(); } catch (_) {}
    }
    try {
      state = JSON.parse(snapStr);
      try { localStorage.setItem(KEY, snapStr); } catch (e2) { /* 旧态写回尽力而为 */ }
    } catch (parseErr) { state = null; }
    return { ok: false, result: undefined };
  }
}

/* 损坏数据恢复 API（v4 §6.B）：查看 / 导出原文 / 确认后清除 */
export function corruptInfo() { return (state && state.__corrupt) || (load().__corrupt) || null; }
export function exportCorruptRaw(backupKey) {
  try { return localStorage.getItem(backupKey); } catch (e) { return null; }
}
export function clearCorrupt(backupKey, { confirm = false } = {}) {
  if (!confirm) return false;                       // 未确认不得移除备份
  try { localStorage.removeItem(backupKey); } catch (e) {}
  const s = load();
  if (s.__corrupt && s.__corrupt.backupKey === backupKey) { delete s.__corrupt; save(); }
  return true;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- 家庭 ---------------- */

export function listFamilies() { return load().families; }
export function getFamily(id) { return load().families.find(f => f.id === id) || null; }

export function addFamily({ id = null, name, city, isExample = false }) {
  const s = load();
  const fam = {
    id: id || uid(),
    name: name.trim(),
    city,
    colorIdx: s.families.length % 6,
    isExample,
    createdAt: Date.now(),
  };
  const r = commit(() => { s.families.push(fam); return fam; });
  return r.ok ? fam : null;
}

export function updateFamily(id, patch) {
  const fam = getFamily(id);
  if (!fam) return false;
  return commit(() => { Object.assign(fam, patch); return fam; }).ok;
}

/** 删除家庭。opts.deletePlants=true 时同时删除该家庭全部植物档案与照片；否则要求先把植物转移走 */
export function deleteFamily(id, { deletePlants = false } = {}) {
  const s = load();
  const plants = s.plants.filter(p => p.familyId === id);
  const r = commit(() => {                 // 嵌套保护：内部仅改内存，由本次 commit 统一落盘
    if (deletePlants) for (const p of plants) _deletePlantInMemory(p.id);
    s.families = s.families.filter(f => f.id !== id);
    if (s.prefs.activeFamilyFilter === id) s.prefs.activeFamilyFilter = 'all';
    if (s.prefs.lastAddFamilyId === id) delete s.prefs.lastAddFamilyId;
  });
  return r.ok ? true : null;
}

export function plantsOfFamily(id) {
  return load().plants.filter(p => p.familyId === id);
}

/* ---------------- 摆放位置（轻量空间档案，v3 §4） ----------------
  space: { id, homeId, name, exposure: 室内|半室外|室外|未知,
           light: '', air: '', rain: 未知|基本不淋雨|会淋雨, note: '',
           createdAt, updatedAt }
  字段宽松，全部可选；"未知"就是未知——引擎绝不按名称（阳台/走廊）臆测光照通风。
  同一位置的长期环境多盆复用；植物个体差异走 plant.env.micro，不回写共享字段。 */

export function listSpaces(homeId) { return load().spaces.filter(s => s.homeId === homeId); }
export function getSpace(id) { return load().spaces.find(s => s.id === id) || null; }

export function addSpace({ id = null, homeId, name, exposure = '未知', light = '', air = '', rain = '未知', note = '' }) {
  const s = load();
  const sp = { id: id || uid(), homeId, name: String(name || '').trim() || '未命名位置', exposure, light, air, rain, note: String(note || '').trim(), createdAt: Date.now(), updatedAt: Date.now() };
  const r = commit(() => { s.spaces.push(sp); return sp; });
  return r.ok ? sp : null;
}

export function updateSpace(id, patch) {
  const sp = getSpace(id);
  if (!sp) return false;
  return commit(() => { Object.assign(sp, patch); sp.updatedAt = Date.now(); return sp; }).ok;
}

/** 删除位置：植物移入「暂未设置」，绝不删植物（v3 §5 迁移要求） */
export async function deleteSpace(id) {
  const s = load();
  const here = s.plants.filter(p => p.spaceId === id);
  const r = commit(() => {
    for (const p of here) p.spaceId = null;
    s.spaces = s.spaces.filter(x => x.id !== id);
  });
  return r.ok ? { moved: here.length } : null;
}

export function spacePlantCount(id) { return load().plants.filter(p => p.spaceId === id).length; }

/* ---------------- 植物 ----------------

  plant: {
    id, familyId, name（展示名）, nickname?,
    knowledgeKey,            // 关联知识库条目；null = 待确认
    identity: { cnName, sciName, variety?, source: 'knowledge'|'manual'|'pending' },
    identityPending: bool,
    isExample?,
    env: {
      position?,             // 摆放位置描述文字
      tags: [ {text, source: 'user'|'photo'} ],
      hydro?: true           // 水培标记（由知识库带入）
    },
    notes: [ {text, source:'user'|'voice', tag?, createdAt} ],  // 长期背景（如"冬天开暖气"）
    photoIds: [],
    createdAt, updatedAt
  }

注意：plant 上没有任何浇水/施肥日期字段。
*/
export function listPlants() { return load().plants; }
export function getPlant(id) { return load().plants.find(p => p.id === id) || null; }

export function addPlant(data) {
  const s = load();
  const now = Date.now();
  const p = {
    id: data.id || uid(),
    familyId: data.familyId,
    name: data.name,
    nickname: data.nickname || '',
    knowledgeKey: data.knowledgeKey || null,
    identity: data.identity || { cnName: data.name, sciName: '', source: 'manual' },
    identityPending: !!data.identityPending,
    isExample: !!data.isExample,
    spaceId: data.spaceId ?? null,           // 摆放位置（null=暂未设置，v3 T01）
    env: { position: data.position || '', micro: data.micro || '', tags: data.envTags ? data.envTags.map(t => typeof t === 'string' ? ({ text: t, source: 'user' }) : t) : [] },
    notes: [],
    photoIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const r = commit(() => { s.plants.push(p); return p; });
  return r.ok ? p : null;
}

export function updatePlant(id, patch) {
  const p = getPlant(id);
  if (!p) return null;
  const r = commit(() => {
    let dirty = false;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'env' || k === 'identity') {
        Object.assign(p[k], v);
      } else {
        p[k] = v;
      }
      dirty = true;
    }
    if (dirty) p.updatedAt = Date.now();
    return p;
  });
  return r.ok ? p : null;
}

/** 仅改内存的删除（供 deleteFamily 等批量提交内部复用，不单独落盘） */
function _deletePlantInMemory(id) {
  const s = load();
  const p = s.plants.find(x => x.id === id);
  if (!p) return;
  for (const pid of p.photoIds) delete s.photos[pid];
  s.observations = s.observations.filter(o => o.plantId !== id);
  s.plants = s.plants.filter(x => x.id !== id);
}

/** 删除一盆植物：同时删除它的照片、观察与背景备注；不影响其他植物 */
export function deletePlant(id, { silent = false } = {}) {
  const had = !!getPlant(id);
  if (!had) return true;                       // 幂等：已不存在视为成功
  const r = commit(() => _deletePlantInMemory(id));
  return r.ok ? true : null;
}

/** 转移到另一家庭；植物的城市与季节背景随新家庭变化 */
export function movePlant(id, familyId) {
  updatePlant(id, { familyId });
}

/* ---------------- 照片 ---------------- */

export async function savePhoto(dataUrl, { capturedAt = null, oldPhoto = false, forceId = null, region = null } = {}) {
  // 元信息入 state；图片数据优先写 IndexedDB，无 IDB/写失败时内联降级（见 db.js）
  // region（v4 §2.10）：局部图来源标记 { photoId, box } —— 局部图属于某张原图，
  // 原图只存一份、多盆共享；绝不为每盆重复存整屋大图。
  const s = load();
  const ph = { id: forceId || uid(), capturedAt, oldPhoto, region: region || null, createdAt: Date.now() };
  let inline = true;
  if (dbMode() === 'idb') {
    try { if (await putPhotoBlob(ph.id, dataUrl) === true) inline = false; }
    catch (e) { inline = true; }           // IDB 失败 → 内联降级，保持可用
  }
  if (inline) ph.dataUrl = dataUrl;
  s.photos[ph.id] = ph;
  if (!save()) {                            // 容量不足等：回滚并抛错，绝不静默丢图
    delete s.photos[ph.id];
    save();
    if (!inline) { try { await delPhotoBlob(ph.id); } catch (e) {} }
    const err = new Error('本机存储空间不足：这张照片没能保存。可以删除不用的植物/照片，或在设置里导出备份。');
    err.code = 'PHOTO_SAVE_FAILED';
    throw err;
  }
  return ph;
}

export async function getPhoto(id) {
  const ph = load().photos[id] || null;
  if (!ph) return null;
  if (ph.dataUrl) return ph;               // 内联模式
  try {
    const dataUrl = await getPhotoBlob(ph.id);
    return dataUrl ? { ...ph, dataUrl } : { ...ph, dataUrl: null };
  } catch (e) { return { ...ph, dataUrl: null }; }
}

export async function detachPhoto(id) {
  delete load().photos[id];
  await delPhotoBlob(id);
  save();
}

/** 一次性：旧版内联照片数据迁移到 IndexedDB（v3 7.4；幂等、先备份后迁移、可回滚） */
export async function migratePhotosToIDBOnce() {
  const s = load();
  if (s.prefs.photosIDBDone) return { skipped: true };
  if (dbMode() !== 'idb') { s.prefs.photosIDBDone = true; s.prefs.photoMode = 'local'; save(); return { skipped: true, mode: 'local' }; }
  const inline = Object.values(s.photos).filter(p => p && p.dataUrl);
  if (inline.length) {
    try {                                   // 回滚保护：迁移前把原照片数据整体备份一次
      if (!localStorage.getItem('zhiban:backup-pre-idb')) localStorage.setItem('zhiban:backup-pre-idb', JSON.stringify(s.photos));
    } catch (e) { /* 备份写不进也继续迁移：本身是向前迁移且 IDB 已成功才算完成 */ }
  }
  let moved = 0, kept = 0;
  for (const ph of inline) {
    try { if (await putPhotoBlob(ph.id, ph.dataUrl) === true) { delete ph.dataUrl; moved++; } else kept++; }
    catch (e) { kept++; }
  }
  s.prefs.photosIDBDone = true;
  s.prefs.photoMode = 'idb';
  save();
  return { moved, kept };
}

/* ---------------- 观察（变化记录，非操作流水） ---------------- */

export const OBS_TAGS = {
  bud: '花苞', flower: '开花', 'new-shoot': '新芽新叶', 'yellow-leaf': '黄叶',
  'brown-tip': '叶尖枯焦', spot: '斑点', pest: '小虫', wilt: '叶片下垂蔫软', drop: '落叶掉苞', leggy: '徒长', weak: '长势变差',
};

export function addObservation({ plantId, tags = [], text = '', source = 'user', photoId = null, uncertain = false, isCurrentState = true, stateAt = null }) {
  const s = load();
  const o = {
    id: uid(), plantId, tags,
    text: text.trim(), source, photoId,
    uncertain: !!uncertain,
    isCurrentState: isCurrentState !== false,
    stateAt: stateAt || Date.now(),
    createdAt: Date.now(),
  };
  const r = commit(() => { s.observations.push(o); return o; });
  return r.ok ? o : null;
}

export function listObservations(plantId) {
  return load().observations
    .filter(o => o.plantId === plantId)
    .sort((a, b) => b.stateAt - a.stateAt);
}

/** 近 N 天内、被认定为当前状态的有效观察（排除旧照） */
export function recentObservations(plantId, days = 30) {
  const since = Date.now() - days * 86400000;
  return listObservations(plantId).filter(o => o.isCurrentState && o.stateAt >= since);
}

export function obsTagLabel(tag) { return OBS_TAGS[tag] || tag; }

/* ---------------- 背景备注（长期信息，如"冬天开暖气"） ---------------- */

export function addNote(plantId, text, tag = null) {
  const p = getPlant(plantId);
  if (!p) return;
  const r = commit(() => {
    p.notes.push({ text: text.trim(), source: 'user', tag, createdAt: Date.now() });
    p.updatedAt = Date.now();
    return p;
  });
  return r.ok ? true : null;
}

/* ---------------- 偏好 ---------------- */

export function setPref(k, v) {
  const s = load();
  return commit(() => { s.prefs[k] = v; }).ok;
}

/* ---------------- 批量识别草稿与幂等提交（v4 §2.9 / §6.A） ----------------
   批次草稿存独立键 zhiban:batch-draft：不进主 state，不参与主数据每次 commit 的
   全量序列化快照（草稿轻量，只存引用与编辑状态）。
   红线：识别结果先存草稿——取消不产生正式植物；返回/重试不丢已确认的编辑；
   提交使用稳定批次ID+预生成目标plantId，重复点击、刷新中断、重试都不重复建档；
   部分成功明确逐项状态，只重试失败项。 */

const BATCH_KEY = 'zhiban:batch-draft';

export function loadBatchDraft() {
  try { return JSON.parse(localStorage.getItem(BATCH_KEY) || 'null'); }
  catch (e) { return null; }
}

export function saveBatchDraft(batch) {
  try {
    localStorage.setItem(BATCH_KEY, JSON.stringify(batch));
    return true;
  } catch (e) {
    lastSaveFailed = true;
    console.error('批次草稿保存失败（本机存储空间可能已满）', e);
    if (typeof globalThis !== 'undefined' && globalThis.__zhibanSaveFailHook) {
      try { globalThis.__zhibanSaveFailHook(); } catch (_) {}
    }
    return false;
  }
}

export function clearBatchDraft() {
  try { localStorage.removeItem(BATCH_KEY); } catch (e) {}
}

/** 把照片挂到植物档案（局部图可用 region 标记来源原图与区域） */
export function attachPhoto(plantId, photoId, { region } = {}) {
  const p = getPlant(plantId);
  if (!p) return false;
  const s = load();
  const r = commit(() => {
    if (region) {
      const ph = s.photos[photoId];
      if (ph) ph.regionOf = region;
    }
    if (!p.photoIds.includes(photoId)) p.photoIds.push(photoId);
    p.updatedAt = Date.now();
  });
  return r.ok;
}

/**
 * 幂等批量提交（v4 §2.9 / §6.A）。
 * batch 形状（由 batch.js 组装）：
 *   { homeId, capturedAt?, photoIds: [原图photoId...], done: [已成功的detectionId...],
 *     detections: [{ detectionId, photoId, box, candidates, scene?,
 *                    selected, merged, chosenName?, chosenKey?, spaceId?,
 *                    cropDataUrl?, plantId?(预生成目标ID) }] }
 * hooks.makeCrop(d) 返回局部图 dataUrl（或 null 跳过局部图）；由 UI 层生成（canvas 在 store 之外）。
 * 返回 { ok, created:[plantId...], failed:[{detectionId,error}], batch }——
 * 成功项同步记入 batch.done；调用方保存草稿即可断点续传。
 */
export async function commitBatch(batch, hooks = {}) {
  const b = batch;
  if (!b || !Array.isArray(b.detections)) return { ok: false, created: [], failed: [], msg: 'no-batch', batch: b };
  b.done = Array.isArray(b.done) ? b.done : [];
  const created = [], failed = [];
  for (const d of b.detections) {
    if (!d || !d.selected || d.merged) continue;
    if (b.done.includes(d.detectionId)) continue;      // 幂等：已成功项绝不重建
    try {
      if (hooks.onBefore) await hooks.onBefore(d);    // 逐项开始钩子（进度/测试注入）
      const plantId = d.plantId || uid();             // 稳定目标ID：重试沿用同一个
      d.plantId = plantId;
      const name0 = String(d.chosenName || '').trim() || (d.candidates && d.candidates[0] && d.candidates[0].name) || '待确认植物';
      const known = !!(d.candidates && d.candidates.length) && !!String(d.chosenName || '').trim();
      const plant = addPlant({
        id: plantId,
        familyId: b.homeId,
        name: name0,
        knowledgeKey: known ? d.chosenKey || null : null,
        identityPending: !known,
        identity: known
          ? { cnName: name0, sciName: '', source: d.chosenKey ? 'knowledge' : 'manual' }
          : { cnName: name0, sciName: '', source: 'pending' },
        spaceId: d.spaceId || null,
      });
      if (!plant) throw new Error('plant-write-failed');
      created.push(plantId);
      b.done.push(d.detectionId);

      /* 场景线索如实入档：来自视觉识别的观察（可删），不与用户确认混同 */
      if (Array.isArray(d.scene) && d.scene.length) {
        addNote(plantId, '照片里看到：' + d.scene.join('、') + '（视觉识别时的观察，固化管理去「摆放位置」落实）', 'vision-scene');
      }

      /* 原图复用（§2.10）：同一张原图多盆共享一个 photoId，只存一份 */
      if (d.photoId && !plant.photoIds.includes(d.photoId)) {
        if (!attachPhoto(plantId, d.photoId)) throw new Error('photo-link-failed');
      }

      /* 局部图（每盆主图）：UI 生成；region 标记来源原图与区域 */
      let crop = d.cropDataUrl;
      if (crop === undefined && hooks.makeCrop) crop = await hooks.makeCrop(d);
      if (crop) {
        const ph = await savePhoto(crop, {
          capturedAt: b.capturedAt || null,
          region: d.photoId ? { photoId: d.photoId, box: d.box } : null,
        });
        if (!attachPhoto(plantId, ph.id)) throw new Error('crop-link-failed');
      }
    } catch (e) {
      failed.push({ detectionId: d.detectionId, plantId: d.plantId || null, error: (e && e.message) || String(e) });
    }
  }
  return { ok: failed.length === 0, created, failed, batch: b };
}

export function getPref(k, dflt = null) {
  const v = load().prefs[k];
  return v === undefined ? dflt : v;
}

/* ---------------- 示例数据 ----------------
   示例数据定义在 example-data.js（独立模块，避免循环依赖），
   由设置页 / 首页空状态直接引用；所有示例家庭与植物均带 isExample 标记。 */

/** 清除全部数据（设置页入口） */
export function clearAll() {
  state = blank();
  save();
}

/** 清除示例家庭（含其植物/照片/观察） */
export function removeExamples() {
  const s = load();
  const exFamIds = s.families.filter(f => f.isExample).map(f => f.id);
  for (const id of exFamIds) deleteFamily(id, { deletePlants: true });
  s.plants = s.plants.filter(p => !p.isExample);
  save();
}

/** 本机存的照片等大对象体积告警（localStorage 上限约 5MB） */
export function storageEstimateKB() {
  try {
    const raw = localStorage.getItem(KEY) || '';
    return Math.round(raw.length * 2 / 1024);
  } catch (e) { return -1; }
}
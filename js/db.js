// ============================================================
// db.js — 照片数据层（IndexedDB 优先 + localStorage 降级）
//
// 为什么：localStorage 上限约 5MB，30 盆 × 3 张压缩照就会写满。
// T19/7.4 要求：容量不足、写入失败必须可见，且不丢原数据。
// - IndexedDB 模式：照片数据（dataUrl）存 IDB，元信息仍在
//   state.photos（localStorage）。容量按浏览器配额（通常远大于 5MB）。
// - local 降级模式：jsdom/极老环境无 IDB 时，dataUrl 内嵌元信息，
//   行为与旧版一致（测试环境与降级兜底）。
// - 任何一层写入失败都会向上抛出，由调用方提示；不会静默显示成功。
// ============================================================

let idb = null;
let mode = 'local';

export async function initDB() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return dbMode();
    idb = await new Promise((res, rej) => {
      const rq = indexedDB.open('zhiban-photos', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('photos'); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('IndexedDB 打开失败'));
      rq.onblocked = () => rej(new Error('IndexedDB 被占用'));
    });
    mode = 'idb';
  } catch (e) {
    idb = null;
    mode = 'local';
    console.warn('IndexedDB 不可用，照片将本机内联存储（容量较小）：', e && e.message);
  }
  return dbMode();
}

export function dbMode() { return mode; }

function tx(mode2, fn) {
  return new Promise((res, rej) => {
    try {
      const t = idb.transaction('photos', mode2);
      const st = t.objectStore('photos');
      const rq = fn(st);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('IDB 读写失败'));
      t.onabort = () => rej(t.error || new Error('IDB 事务中止'));
    } catch (e) { rej(e); }
  });
}

/** 写入一张照片的数据。失败抛错（调用方可见），绝不静默。 */
export async function putPhotoBlob(id, dataUrl) {
  if (mode !== 'idb') return false;          // local 模式由 store 内联
  await tx('readwrite', st => st.put(dataUrl, id));
  return true;
}

/** 读一张照片的数据；不存在返回 null */
export async function getPhotoBlob(id) {
  if (mode !== 'idb') return null;
  try { return await tx('readonly', st => st.get(id)); }
  catch (e) { return null; }
}

export async function delPhotoBlob(id) {
  if (mode !== 'idb') return;
  try { await tx('readwrite', st => st.delete(id)); } catch (e) { /* 已不存在 */ }
}

/** 全量读取（备份导出用） */
export async function allPhotoBlobs() {
  if (mode !== 'idb') return {};
  try {
    const keys = await tx('readonly', st => st.getAllKeys());
    const out = {};
    for (const k of keys) out[k] = await tx('readonly', st => st.get(k));
    return out;
  } catch (e) { return {}; }
}

/** 清空照片库（清数据用） */
export async function clearPhotoBlobs() {
  if (mode !== 'idb') return;
  try { await tx('readwrite', st => st.clear()); } catch (e) {}
}
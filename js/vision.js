// ============================================================
// js/vision.js — 视觉适配层（v4 §2 / §3）
//
// 浏览器只在同源代理（server/server.js）上调用；密钥永不下发。
// 服务端不可达/未配置 → 如实返回状态，前端明示，绝不冒充识别成功。
// 坐标口径：box 一律为相对"纠正旋转后的原图"的 0-1 归一化矩形（左上原点），
// 校验规则与 server/lib.mjs 同源复用（纯函数，浏览器可直接 import）。
// ============================================================
/** 前端框校验（与 server/lib.mjs 同规则；v5 起不跨界 import——
 *  server 端校验仍是独立安全边界，此处只是输入清洗的第一道） */
function validateBox(b) {
  if (!b || typeof b !== 'object') return false;
  const { x, y, w, h } = b;
  const nums = [x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums) return false;
  if (w <= 0.005 || h <= 0.005) return false;
  if (x < -0.02 || y < -0.02) return false;
  if (x + w > 1.02 || y + h > 1.02) return false;
  return true;
}

/** 分辨率分档（v4 §3：不能把小缩略图放大去辨认远处叶片） */
export const VISION_MAX_SIDE = 1408;   // 分析图长边——发服务端识别用，只存内存，不进档案
export const ARCHIVE_MAX_SIDE = 1024; // 存档原图长边——批量建档的原图存档；多盆共享一份

/** 测试/特殊部署可注入 API 基址；默认同源。 */
const API_BASE = (typeof globalThis !== 'undefined' && globalThis.__zhibanApiBase) || '';
/* v5 线上：访问 key 由服务端注入到 index.html；本地无 key 时不带头（server 不校验） */
const zhKeyH = () => (typeof window !== 'undefined' && window.__ZH_KEY) ? { 'x-zh-key': window.__ZH_KEY } : {};

/** 联通检查：vision/weather 凭证状态如实回报；服务未启动返回 null（离线）。 */
export async function visionHealth() {
  try {
    const r = await fetch(API_BASE + '/api/health');
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/** 逐图检测：并发 ≤2（限制请求，v4 §3）；单图失败不清空整批；可取消。
 *  返回 results[photoIdx] = { status:'ok'|'error', mode, detections?, error?, msg? }
 *  每张图独立成败，与后续确认流程解耦——识别失败的照片可单独重试。 */
export async function detectPhotos(images, { onProgress, signal } = {}) {
  const jobs = images.map((image, photoIdx) => ({ image, photoIdx }));
  const results = new Array(images.length);
  const queue = [...jobs];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const job = queue.shift();
      if (!job) return;
      try {
        const r = await fetch(API_BASE + '/api/vision/detect', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...zhKeyH() },
          body: JSON.stringify({ image: job.image }),
          signal,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(data.detections)) {
          results[job.photoIdx] = {
            photoIdx: job.photoIdx, status: 'error', mode: data.mode || null,
            error: data.error || ('http-' + r.status), msg: data.msg || '',
          };
        } else {
          // 坐标校验：范围/宽高/越界容差不合法的框直接丢弃，不画假框（v4 §3）
          const detections = data.detections.filter(d => validateBox(d && d.box));
          results[job.photoIdx] = { photoIdx: job.photoIdx, status: 'ok', mode: data.mode, detections };
        }
      } catch (e) {
        results[job.photoIdx] = {
          photoIdx: job.photoIdx, status: 'error',
          error: (e && e.name === 'AbortError') ? 'aborted' : 'unreachable',
          msg: (e && e.message) || '',
        };
      }
      done++;
      if (onProgress) onProgress(done, jobs.length);
    }
  };
  await Promise.all(Array(Math.min(2, Math.max(1, images.length))).fill(0).map(worker));
  return results;
}

/** 局部图裁剪：从原图 dataUrl 按 box（0-1 归一化）裁出每盆主图。
 *  原图只存一份（多盆共享 photoId）；局部图另有 region 来源标记（store.savePhoto）。 */
export function cropPhoto(dataUrl, box) {
  return new Promise((resolve, reject) => {
    if (!validateBox(box)) return reject(new Error('box 非法：需要 0-1 归一化矩形 {x,y,w,h}'));
    const img = new Image();
    img.onload = () => {
      try {
        const x = Math.max(0, Math.round(box.x * img.width));
        const y = Math.max(0, Math.round(box.y * img.height));
        const w = Math.min(img.width - x, Math.max(4, Math.round(box.w * img.width)));
        const h = Math.min(img.height - y, Math.max(4, Math.round(box.h * img.height)));
        if (w <= 0 || h <= 0) return reject(new Error('局部区域无效'));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('原图读取失败'));
    img.src = dataUrl;
  });
}

/** 摘要计数（v4 §2.2/§2.3）：从当前（用户可能已删/合并后的）检测结果实际计算，
 *  不信模型自由文本里的 count 字段。口径：候选把握 high/medium 才算"可辨认"——
 *  只有 low 或无候选（区域找到了但认不出）一律算"待确认"，不夸大。 */
export function summarizeCounts(detections) {
  let known = 0, pending = 0;
  for (const d of detections) {
    if (!d || d.merged || d.removed) continue;
    const best = d.candidates && d.candidates[0];
    if (best && best.name && (best.confidence === 'high' || best.confidence === 'medium')) known++;
    else pending++;
  }
  return { known, pending };
}

/** 跨照片疑似重复建议（v4 §2.8）：只产出可解释的"建议"，绝不自动合并——
 *  合并必须由用户逐条确认（同种两盆默认保留两个独立实例）。 */
export function planDuplicateHints(detections) {
  const hints = [];
  const list = (detections || []).filter(d => d && !d.merged && !d.removed && d.box);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.photoIdx === b.photoIdx) continue;               // 同一张照片内不做跨图建议
      const ca = a.candidates && a.candidates[0];
      const cb = b.candidates && b.candidates[0];
      if (!ca || !cb || !ca.name || ca.name !== cb.name) continue;
      const sizeClose =
        Math.abs(a.box.w - b.box.w) < 0.28 &&
        Math.abs(a.box.h - b.box.h) < 0.28 &&
        Math.abs((a.box.w / a.box.h) - (b.box.w / b.box.h)) < 0.35;
      if (!sizeClose) continue;
      hints.push({
        a: a.detectionId, b: b.detectionId,
        reason: `两张照片里都认出「${ca.name}」且大小相近——可能是同一盆（视角重叠），也可能只是长得像。由你确认：勾"同一盆"只留一盆；不确定就保留两盆，两个独立档案不受影响`,
      });
    }
  }
  return hints;
}
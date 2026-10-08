// ============================================================
// services.js — 模块化服务适配层
//
// 原则：每一项能力独立成模块；没有真实接口的能力，
// 明确标注「未接入」，并提供可用/可跳过的降级路径；
// 绝不用固定答案冒充识别、用模拟数据冒充实时。
// 各能力的接入状态对用户可见（设置页展示本清单）。
// ============================================================

export const providers = {
  // —— v3 §1：逐项如实分列，不把不同能力合并成"AI 已接入/未接入" ——
  symptomTriage: { name: '症状排查（哪里不对）', status: '已内建（主路径）', note: '选看到的现象 + 最多两题可跳过的追问 → 给出排查方向与 1—3 条动作（规则 + 13 种植物知识）。这是正式功能，不是降级；不拍照也完整可用。' },
  plantId:    { name: '拍照识别植物名称', status: '未接入', note: '仍是自动建档的重要缺口：需要服务端视觉识别（密钥不进浏览器）。当前用「从常见植物中搜索选择 / 待确认」替代——手动能用不等于识别已完成。' },
  photoHealth:{ name: '照片病虫害分析', status: '未接入（可选增强）', note: '视觉初筛只用于预填候选现象，接入前后症状主路径不变；未实测样本不会宣称任何准确率。' },
  photoEnv:   { name: '照片可见环境提取', status: '未接入', note: '当前环境信息由你在「摆放位置」确认（或一句话更正）；不会把单张照片当作全天环境测量。' },
  weather:    { name: '实时天气', status: '未接入', note: '按家庭城市的气候分区 + 月份给出通用季节参考，标注"季节推测"，不冒充实况；接入后仅用于室外/半室外位置的风险筛选。' },
  geo:        { name: '定位（城市候选）', status: '浏览器原生（可拒绝）', note: '仅用于就近给出城市候选、由你确认；坐标不保存；拒绝或不可用直接手动选，不阻塞。' },
  speech:     { name: '语音转写', status: '浏览器原生（视设备支持）', note: '不可用时文字输入完整可用（同一整理流程）。' },
  nlp:        { name: '语音语义整理', status: '内置规则（示例级）', note: '词法规则整理成档案 diff；许多用例已内建断言验证（否定/未来意愿/模糊指向等）；接入模型可替换增强，验收按实际用例而非是否用了模型。' },
  store:      { name: '本机存储（档案+照片）', status: '已内建（分层）', note: '档案 localStorage + 照片 IndexedDB（无 IDB 环境自动内联降级）；写入失败全局可见提示，不留静默丢失。' },
  tts:        { name: '朗读建议', status: '浏览器原生', note: '点击「听一听」才播放，不自动播报。' },
};

/* ---------------- 定位（只取坐标换候选城市，不保存坐标） ---------------- */

export function getLocation({ timeout = 8000 } = {}) {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return resolve({ ok: false, error: '当前设备不支持定位，请手动选择城市' });
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ ok: true, lng: pos.coords.longitude, lat: pos.coords.latitude }),
      err => resolve({
        ok: false,
        error: err && err.code === 1 ? '未获得定位权限，可手动选择城市' : '定位失败，可手动选择城市',
      }),
      { timeout, maximumAge: 600000 }
    );
  });
}

/* ---------------- 照片：压缩 + 拍摄时间估计 ---------------- */

/** 压缩为 JPEG dataURL。
 *  v4 §3 分辨率分档（不能把小缩略图放大去辨认）：
 *   · 展示缩略（640，默认）——应用内列表展示；
 *   · 存档原图（1024，0.8）——批量建档的原图存档（vision.js ARCHIVE_MAX_SIDE）；
 *   · 分析图（1408，0.86）——发服务端做视觉识别（vision.js VISION_MAX_SIDE），
 *     只存在于内存，识别完即弃，不进档案。 */
export function compressImage(file, maxSide = 640, quality = 0.66) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/** 按文件时间估计拍摄时间（相册截图/转发图并不可靠，界面明说） */
export function photoTimeInfo(file) {
  const ts = file.lastModified || null;
  if (!ts) return { known: false, days: null, old: false, ts: null };
  const days = Math.floor((Date.now() - ts) / 86400000);
  return { known: true, days, old: days > 40, ts };
}

/* ---------------- 朗读（点「听一听」时才播放） ---------------- */

export function speakSupported() {
  return typeof window !== 'undefined' && !!window.speechSynthesis;
}

export function speakText(text, onEnd) {
  if (!speakSupported()) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.95;
    if (onEnd) u.onend = onEnd;
    window.speechSynthesis.speak(u);
    return true;
  } catch (e) { return false; }
}

export function stopSpeak() {
  if (speakSupported()) window.speechSynthesis.cancel();
}

/* ---------------- 语音识别（浏览器原生；拒绝/不支持→文字输入） ---------------- */

export function speechSupported() {
  return typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** 返回 controller；调用方用 controller.stop() 结束 */
export function listenSpeech({ onResult, onEnd, onError } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError && onError(new Error('当前浏览器不支持语音识别，请用下方文字输入（功能完全相同）'));
    return null;
  }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = e => {
    const t = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
    if (t) onResult && onResult(t);
  };
  rec.onend = () => onEnd && onEnd();
  rec.onerror = e => {
    const msg = e && e.error === 'not-allowed' ? '未获得麦克风权限，请用文字输入（功能相同）'
      : (e && e.error === 'no-speech') ? '没听清，请再按住说一次，或直接用文字输入'
      : '语音识别不可用，请用文字输入';
    onError && onError(new Error(msg));
    onEnd && onEnd();
  };
  try { rec.start(); } catch (err) { onError && onError(err); return null; }
  return { stop() { try { rec.stop(); } catch (e) {} } };
}

/* ---------------- 剪贴板与下载 ---------------- */

export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- 五行小卡 → 简洁黑白图片（黑白也清楚） ---------------- */

export function cardImage(lines, { name = '小卡' } = {}) {
  const W = 720, M = 54;
  const font = 60;
  const lineH = Math.round(font * 1.85);
  const topPad = 68, bottomPad = 88;   // v4 §6.E：图片五行与卡片一致——顶部不再画"长期养护规则"小注
  const H = topPad + bottomPad + lineH * 5;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // 白底 + 黑边框
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#111111';
  g.lineWidth = 8;
  g.strokeRect(14, 14, W - 28, H - 28);

  g.textAlign = 'center';   // v4 §6.E：小注已移除，图片只包含五行卡片内容

  g.fillStyle = '#111111';
  g.font = `700 ${font}px "PingFang SC","Microsoft YaHei",sans-serif`;
  lines.forEach((s, i) => {
    g.fillText(s, W / 2, topPad - 6 + lineH * i + font);
  });

  return { dataUrl: c.toDataURL('image/png'), width: W, height: H };
}
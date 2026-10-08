// ============================================================
// js/weather.js — 和风天气适配层（v4 §5）
//
// 所有请求走同源代理（server/server.js → 和风）；浏览器永不见密钥。
// 诚实原则（硬性）：
//   · 来源/获取时间/观测时间分清——没有观测时间不用请求时间冒充；
//   · 字段缺失是 null，真实 0 值仍是 0（两者绝不混淆）；
//   · 缓存按城市与接口分账：实况 30 分钟、预报 6 小时；到期必须标注
//     stale，由展示层明示"过期"，绝不冒充今日实况；
//   · 未配置/鉴权失败/限流/超时/离线分别给出可理解错误；完全不可用
//     才回到明确标注的季节参考（engine 原有逻辑），不做天气挂件式摆设。
// 城市模型：fam.city.qw = { id, lat, lon }——服务方返回的"城市代表坐标"，
//   不是用户手机的精确位置；LBS 坐标只用于当次反查不保存。
// ============================================================

const API_BASE = (typeof globalThis !== 'undefined' && globalThis.__zhibanApiBase) || '';
/* v5 线上：访问 key 由服务端注入到 index.html；本地无 key 时不带头（server 不校验） */
const zhKeyH = () => (typeof window !== 'undefined' && window.__ZH_KEY) ? { 'x-zh-key': window.__ZH_KEY } : {};
const CACHE_KEY = 'zhiban:weather-cache';
const LIFE = { currentMin: 30, dailyMin: 360 };

/* ---------- 工具：数值归一（缺失是 null，0 是有效值） ---------- */
const num = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

function loadCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
function saveCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 缓存写不进不致命 */ } }
const cacheKeyOf = qw => String(qw.id || (qw.lon + ',' + qw.lat));

/* ---------- 城市搜索 / 坐标反查（GeoAPI 经代理；坐标串由 server 显式转换） ---------- */
export async function searchCity(name) {
  try {
    const r = await fetch(API_BASE + '/api/weather/city-lookup?name=' + encodeURIComponent(String(name).slice(0, 40)), { headers: zhKeyH() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'error', error: body.error || ('http-' + r.status), msg: body.msg || '' };
    const list = (body.data && body.data.location) || [];
    return {
      status: 'ok',
      candidates: list.map(c => ({
        id: c.id, name: c.name,
        adm1: c.adm1 || '', adm2: c.adm2 || '',
        adm: [c.adm1, c.adm2].filter(Boolean).join(' · '),
        lat: num(c.lat), lon: num(c.lon), tz: c.tz || null,
      })),
    };
  } catch (e) { return { status: 'error', error: 'unreachable', msg: (e && e.message) || '' }; }
}

export async function lookupByCoords(lat, lon) {
  try {
    const r = await fetch(API_BASE + `/api/weather/city-lookup?lon=${Number(lon)}&lat=${Number(lat)}`, { headers: zhKeyH() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'error', error: body.error || ('http-' + r.status), msg: body.msg || '' };
    const list = (body.data && body.data.location) || [];
    return { status: 'ok', candidates: list.map(c => ({ id: c.id, name: c.name, adm1: c.adm1 || '', adm2: c.adm2 || '', adm: [c.adm1, c.adm2].filter(Boolean).join(' · '), lat: num(c.lat), lon: num(c.lon), tz: c.tz || null })) };
  } catch (e) { return { status: 'error', error: 'unreachable', msg: (e && e.message) || '' }; }
}

/* ---------- 归一（和风字段 → 统一单位；形状按 2026-10 官方文档，待真凭证联调校对） ---------- */
function normalizeCurrent(d) {
  const now = (d && d.now) || d || {};
  return {
    tempC: num(now.temp),
    humidityPct: num(now.humidity),
    windKmh: num(now.windSpeedKmh !== undefined ? now.windSpeedKmh : now.windSpeed),
    precipMm: num(now.precip),
    text: now.text || now.condTxt || null,
    obsTime: now.obsTime || now.obstime || null,   // 和风数据体的观测时间；绝不拿请求时间冒充
    provider: 'qweather',
  };
}
function normalizeDaily(d) {
  const days = (d && (d.daily || d.days)) || [];
  return days.map(x => ({
    date: x.fxDate || x.date || null,
    text: x.textDay || x.text || null,
    maxC: num(x.tempMax !== undefined ? x.tempMax : x.temp_max),
    minC: num(x.tempMin !== undefined ? x.tempMin : x.temp_min),
    precipMm: num(x.precip),
    precipProbPct: num(x.precipProb),
  }));
}

async function wxFetch(pathname, body) {
  try {
    const r = await fetch(API_BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...zhKeyH() },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'error', error: j.error || ('http-' + r.status), msg: j.msg || '' };
    return { status: 'ok', data: j.data, fetchedAt: j.fetchedAt || Date.now() };
  } catch (e) {
    return { status: 'error', error: (e && e.name === 'AbortError') ? 'timeout' : 'unreachable', msg: (e && e.message) || '' };
  }
}

/* ---------- 实况 / 预报（缓存 + 过期标注；请求失败回退过期缓存并明示） ---------- */
export async function currentFor(fam, { force = false } = {}) {
  const qw = fam && fam.city && fam.city.qw;
  if (!qw || !Number.isFinite(Number(qw.lat)) || !Number.isFinite(Number(qw.lon))) {
    return { status: 'no-city', msg: '城市还没确认（或没有城市坐标）——在「摆放位置」里选一次城市' };
  }
  const key = cacheKeyOf(qw);
  const cache = loadCache();
  const hit = cache[key] && cache[key].current;
  if (!force && hit && !isStale(hit, LIFE.currentMin)) return { status: 'ok', stale: false, data: hit.data };
  const r = await wxFetch('/api/weather/current', { lat: Number(qw.lat), lon: Number(qw.lon) });
  if (r.status !== 'ok') {
    if (hit) return { status: 'ok', stale: true, data: hit.data, note: '刚请求失败，用的是过期缓存', failedWith: r.error };
    return r;    // { status:'error', error:'qweather-unconfigured'|'qweather-auth'|'qweather-rate-limit'|'timeout'|'unreachable', msg }
  }
  const entry = { at: r.fetchedAt, data: normalizeCurrent(r.data), lifeMin: LIFE.currentMin };
  if (!cache[key]) cache[key] = {};
  cache[key].current = entry;
  saveCache(cache);
  return { status: 'ok', stale: false, data: entry.data };
}

export async function dailyFor(fam, { force = false } = {}) {
  const qw = fam && fam.city && fam.city.qw;
  if (!qw || !Number.isFinite(Number(qw.lat))) return { status: 'no-city', msg: '城市还没确认' };
  const key = cacheKeyOf(qw);
  const cache = loadCache();
  const hit = cache[key] && cache[key].daily;
  if (!force && hit && !isStale(hit, LIFE.dailyMin)) return { status: 'ok', stale: false, data: hit.data };
  const r = await wxFetch('/api/weather/daily', { lat: Number(qw.lat), lon: Number(qw.lon) });
  if (r.status !== 'ok') {
    if (hit) return { status: 'ok', stale: true, data: hit.data, note: '刚请求失败，用的是过期缓存', failedWith: r.error };
    return r;
  }
  const entry = { at: r.fetchedAt, data: normalizeDaily(r.data), lifeMin: LIFE.dailyMin };
  if (!cache[key]) cache[key] = {};
  cache[key].daily = entry;
  saveCache(cache);
  return { status: 'ok', stale: false, data: entry.data };
}

function isStale(entry, lifeMin) {
  return (Date.now() - entry.at) > lifeMin * 60000;
}

/* ---------- 引擎消费（同步读：建议引擎只用"新鲜"缓存；过期由 UI 展示） ----------
   缓存的背后更新是 fire-and-forget：首页打开时 main.js 调 refreshQuiet(fam)，
   本次渲染用旧缓存（若有），下次打开即新鲜——不在建议渲染路径上等网络。 */
export function freshCurrent(fam) {
  const qw = fam && fam.city && fam.city.qw;
  if (!qw) return null;
  const hit = (loadCache()[cacheKeyOf(qw)] || {}).current;
  if (!hit || isStale(hit, hit.lifeMin || LIFE.currentMin)) return null;
  return hit.data;
}
export function freshDaily(fam) {
  const qw = fam && fam.city && fam.city.qw;
  if (!qw) return null;
  const hit = (loadCache()[cacheKeyOf(qw)] || {}).daily;
  if (!hit || isStale(hit, hit.lifeMin || LIFE.dailyMin)) return null;
  return hit.data;
}

/** 正在下雨：降水>0.1mm 或 天气文本含"雨"（观测级判断） */
export function rainingNow(wx) {
  if (!wx) return false;
  if (wx.precipMm !== null && wx.precipMm > 0.1) return true;
  return typeof wx.text === 'string' && /雨/.test(wx.text);
}
/** 未来几天有雨（预报数组；日降水>0 或 概率≥60 或 文本含雨） */
export function rainDays(daily, withinDays = 3) {
  if (!Array.isArray(daily)) return 0;
  return daily.slice(0, withinDays).filter(d =>
    (d.precipMm !== null && d.precipMm > 0) ||
    (d.precipProbPct !== null && d.precipProbPct >= 60) ||
    (typeof d.text === 'string' && /雨/.test(d.text))
  ).length;
}
/** 高温判断（≥35℃ 实况） */
export function heatNow(wx, hotC = 35) {
  return !!wx && wx.tempC !== null && wx.tempC >= hotC;
}

/** 静默刷新（渲染后调；网络与凭证永不在建议路径上阻塞 UI） */
export async function refreshQuiet(fam) {
  try { await Promise.all([currentFor(fam, { force: true }), dailyFor(fam, { force: true })]); }
  catch (e) { /* 静默：错误已在各自返回值里分类 */ }
}
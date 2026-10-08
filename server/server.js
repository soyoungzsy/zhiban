#!/usr/bin/env node
// ============================================================
// server/server.js — 植伴最小服务端代理（v4 第二批）
//
// 职责（浏览器永不见密钥）：
//   1) 托管前端静态文件（项目根——替代 python http.server，一个进程全搞定）
//   2) GET  /api/health         联通检查：vision/weather 凭证状态如实报告，不冒充
//   3) POST /api/vision/detect  {image: dataUrl} → 智谱 GLM-4.6V 检测（或演示模式）
//   4) GET  /api/weather/city-lookup?name=杭州   | ?lon=120.16&lat=30.29
//      POST /api/weather/current {lat,lon}  → 和风 /weather/v1/current/{latitude}/{longitude}
//      POST /api/weather/daily   {lat,lon}  → 和风 /weather/v1/daily/{lat}/{lon}?days=7
//
// 启动：
//   node server/server.js                 # 真实凭证模式（server/.env）
//   MOCK_VISION=1 node server/server.js   # 演示模式：固定示例检测；/api/health 与前端均明示"非真实识别"
//
// 凭证：见 server/.env.example；.env 不提交、不打包、不在浏览器出现。
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lonLatForGeoLookup, latLonForWeatherPath, validateLatLon, qweatherAuth,
  glmDetectPayload, normalizeDetection, extractJson,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
const ROOT = path.resolve(here, '..');

function loadEnv() {
  const out = {};
  try {
    const envPath = path.join(here, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && m[2]) out[m[1]] = m[2];
      }
    }
  } catch (e) { /* .env 读不了 → 按未配置处理 */ }
  return out;
}
const envFile = loadEnv();
const CFG = {
  port: Number(process.env.PORT || envFile.PORT || 8438),
  zhipuKey: process.env.ZHIPU_API_KEY || envFile.ZHIPU_API_KEY || '',
  glmModel: process.env.GLM_MODEL || envFile.GLM_MODEL || 'glm-4.6v',
  zwHost: (process.env.QWEATHER_API_HOST || envFile.QWEATHER_API_HOST || '').replace(/\/+$/, ''),
  zwKey: process.env.QWEATHER_KEY || envFile.QWEATHER_KEY || '',
  mockVision: /^(1|true|yes)$/i.test(process.env.MOCK_VISION || envFile.MOCK_VISION || ''),
  apiAccessKey: process.env.API_ACCESS_KEY || envFile.API_ACCESS_KEY || '',   // 设置后付费接口强制校验（未设=本地开发不校验）
  visionDailyLimit: Number(process.env.VISION_DAILY_LIMIT || envFile.VISION_DAILY_LIMIT || 100),
  visionPerMin: Number(process.env.VISION_PER_MIN || envFile.VISION_PER_MIN || 6),
  weatherPerMin: Number(process.env.WEATHER_PER_MIN || envFile.WEATHER_PER_MIN || 30),
};

const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/* ---------------- 访问控制与限流（v5 上线：付费接口不裸奔） ---------------- */
const clientIP = req => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'local';
};
const todayStr = () => new Date().toISOString().slice(0, 10);
const RLV = { perMin: new Map(), day: todayStr(), dayUsed: 0 };
const RLW = { perMin: new Map() };
function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.reset < now) map.delete(k);
}
function takeToken(map, ip, limitPerMin) {
  sweep(map);
  const now = Date.now();
  let e = map.get(ip);
  if (!e) { e = { n: 0, reset: now + 60000 }; map.set(ip, e); }
  if (now >= e.reset) { e.n = 0; e.reset = now + 60000; }
  if (e.n >= limitPerMin) return false;
  e.n++; return true;
}
function checkVision(req) {
  if (RLV.day !== todayStr()) { RLV.day = todayStr(); RLV.dayUsed = 0; }
  if (!takeToken(RLV.perMin, clientIP(req), CFG.visionPerMin)) return { ok: false, msg: `请求太频繁：每分钟最多 ${CFG.visionPerMin} 次，稍等一会再试` };
  if (RLV.dayUsed >= CFG.visionDailyLimit) return { ok: false, msg: `今天的识别调用已达上限（${CFG.visionDailyLimit} 次）——这是连接模型费用的保护上限，明天恢复或联系部署人调整` };
  return { ok: true };
}
function checkWeather(req) {
  if (!takeToken(RLW.perMin, clientIP(req), CFG.weatherPerMin)) return { ok: false, msg: '天气请求太频繁，稍后再试' };
  return { ok: true };
}
function checkKey(req) {
  if (!CFG.apiAccessKey) return true;              // 未配置=本地开发模式，不校验
  return req.headers['x-zh-key'] === CFG.apiAccessKey;
}
const unauthorized = res => send(res, 401, { error: 'unauthorized', msg: '需要访问密钥（x-zh-key）。这是保护付费接口的轻量门槛，不是账号系统。' });

/* ---------------- 工具 ---------------- */
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 5 * 1024 * 1024) {   // v5 上线收紧（分析图 jpeg 足够，超大体说明误传）
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/* ---------------- 视觉检测 ---------------- */

/** 演示模式固定返回：只用于流程验证（勾选/纠正/提交链路），绝不冒充真实识别。 */
function mockDetect() {
  return {
    mode: 'mock',
    summary: '演示数据（3 处区域：2 个命名候选 + 1 处待确认）',
    detections: [
      { box: { x: 0.08, y: 0.12, w: 0.30, h: 0.56 }, candidates: [{ name: '绿萝', confidence: 'high' }, { name: '心叶蔓绿绒', confidence: 'low' }], scene: ['靠窗', '落地放置'] },
      { box: { x: 0.44, y: 0.18, w: 0.24, h: 0.42 }, candidates: [{ name: '多肉', confidence: 'medium' }], scene: ['架子上'] },
      { box: { x: 0.68, y: 0.34, w: 0.24, h: 0.46 }, candidates: [], scene: [] },
    ],
  };
}

async function callGlmDetect(imageDataUrl) {
  const ctrl = new AbortController();                       // v5：30s 超时，不悬挂连接
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try {
    r = await fetch(ZHIPU_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.zhipuKey}` },
      body: JSON.stringify(glmDetectPayload(imageDataUrl, CFG.glmModel)),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`GLM HTTP ${r.status}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.plants)) throw new Error('GLM 返回未能解析为检测结果 JSON');
  return {
    mode: 'live',
    detections: parsed.plants.map(normalizeDetection).filter(Boolean),
  };
}

/* ---------------- 和风天气转发 ---------------- */

async function proxyQweather(res, pathname, params) {
  const qa = qweatherAuth(CFG.zwHost, CFG.zwKey);
  if (!qa) {
    return send(res, 503, {
      error: 'qweather-unconfigured',
      msg: '和风天气未配置：在 server/.env 填写 QWEATHER_API_HOST 与 QWEATHER_KEY（获取方式见 server/.env.example）。',
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(qa.urlOf(pathname, params), { signal: ctrl.signal });
    const body = await r.text();
    let data = null;
    try { data = JSON.parse(body); } catch (e) { data = { raw: body.slice(0, 500) }; }
    if (r.status === 401 || r.status === 403) return send(res, r.status, { error: 'qweather-auth', msg: '和风鉴权失败或权限不足', data });
    if (r.status === 429) return send(res, 429, { error: 'qweather-rate-limit', msg: '和风限流：稍后再试', data });
    if (!r.ok) return send(res, r.status, { error: 'qweather-http', msg: `和风 HTTP ${r.status}`, data });
    /* 注：观测/预报时间一律用和风数据体内的 obsTime/fxTime 等字段；fetchedAt 是代理获取时间，
       两者在前端明确区分，不把请求时间冒充观测时间（v4 §5）。 */
    return send(res, 200, { ok: true, fetchedAt: Date.now(), data });
  } catch (e) {
    if (e && e.name === 'AbortError') return send(res, 504, { error: 'timeout', msg: '和风请求超时（8s）' });
    return send(res, 502, { error: 'unreachable', msg: '和风不可达：检查网络或 API Host 配置' });
  } finally { clearTimeout(timer); }
}

/* ---------------- 静态托管 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

/* v5 上线安全：静态只开放前端资源——REVIEW 等审核文档、服务端源码、
   测试材料、截图、包文件、.env 一律 404。本地开发如需访问源码文档，
   仍可用 python http.server（部署不使用）。 */
const STATIC_ALLOW = (pathname) => {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  if (pathname === '/manifest.webmanifest') return 'manifest.webmanifest';
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/icons/')) return pathname;
  return null;
};
function serveStatic(req, res, pathnameRaw) {
  let pathname;
  try { pathname = decodeURIComponent(pathnameRaw); } catch (e) { return send(res, 400, { error: 'bad-path' }); }
  if (pathname.includes('..')) return send(res, 400, { error: 'bad-path' });
  const rel = STATIC_ALLOW(pathname);
  if (!rel) return send(res, 404, { error: 'not-found', msg: '线上只开放应用资源' });
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 400, { error: 'bad-path' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not-found' });
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // index.html：部署 key 存在时注入（前端脚本带到 API 请求头）；SW 预缓存请求不带
    if (rel === 'index.html' && CFG.apiAccessKey && req.headers['x-sw-precache'] !== '1') {
      let html = buf.toString('utf-8');
      const inject = `\n<script>window.__ZH_KEY=${JSON.stringify(CFG.apiAccessKey)};</script>\n`;
      html = html.replace('<body>', '<body>\n<!-- 访问 key 由服务端运行时注入——源码与缓存中不写死 -->' + inject);
      buf = Buffer.from(html, 'utf-8');
    }
    res.writeHead(200, { 'content-type': mime, ...(rel === '/js/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });   // v5：SW 脚本在 /js/ 下，允许其以 scope '/' 注册——无此头浏览器拒绝
    res.end(buf);
  });
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/health') {
      return send(res, 200, {
        ok: true, name: 'zhiban-proxy', fetchedAt: Date.now(),
        vision: CFG.mockVision
          ? { mode: 'mock', msg: '演示模式：返回固定示例检测，非真实识别' }
          : CFG.zhipuKey
            ? { mode: 'live-ready', msg: '已配置 GLM 密钥', model: CFG.glmModel }
            : { mode: 'missing-key', msg: '未配置 ZHIPU_API_KEY——视觉识别不可用；填写方法见 server/.env.example，或用 MOCK_VISION=1 演示模式跑流程' },
        weather: (CFG.zwHost && CFG.zwKey)
          ? { mode: 'live-ready', msg: '已配置和风凭证' }
          : { mode: 'missing-key', msg: '未配置和风凭证（QWEATHER_API_HOST / QWEATHER_KEY）' },
      });
    }

    if (u.pathname === '/api/vision/detect' && req.method === 'POST') {
      if (!checkKey(req)) return unauthorized(res);
      const gate = checkVision(req);
      if (!gate.ok) return send(res, 429, { error: 'rate-limited', msg: gate.msg });
      const body = JSON.parse(await readBody(req));
      const image = body && body.image;
      if (typeof image !== 'string' || !/^data:image\//.test(image)) return send(res, 400, { error: 'bad-image', msg: '需要 data:image/* 的图片' });
      if (image.length > 4 * 1024 * 1024) return send(res, 413, { error: 'image-too-large', msg: '图片过大（分析图请用压缩后的 JPEG）' });
      if (CFG.mockVision) { RLV.dayUsed++; return send(res, 200, mockDetect()); }
      if (!CFG.zhipuKey) {
        return send(res, 503, { error: 'vision-unconfigured', msg: '未配置 ZHIPU_API_KEY——不能假装识别。填写 server/.env 后重启，或用 MOCK_VISION=1 演示模式跑流程。' });
      }
      try { RLV.dayUsed++; return send(res, 200, await callGlmDetect(image)); }
      catch (e1) {
        try { return send(res, 200, await callGlmDetect(image)); }   // 模型偶发输出不稳：温和重试一次
        catch (e2) { return send(res, 502, { error: 'vision-failed', msg: '视觉服务调用失败：' + (e2.message || e2) }); }
      }
    }

    if (u.pathname === '/api/weather/city-lookup' && req.method === 'GET') {
      if (!checkKey(req)) return unauthorized(res);
      if (!checkWeather(req).ok) return send(res, 429, { error: 'rate-limited', msg: '天气请求太频繁，稍后再试' });
      const name = u.searchParams.get('name');
      const lon = u.searchParams.get('lon'), lat = u.searchParams.get('lat');
      if (name) return proxyQweather(res, '/geo/v2/city/lookup', { location: String(name).slice(0, 40), number: 8 });
      if (lon !== null && lat !== null) {
        const ll = validateLatLon({ lat, lon });
        if (!ll) return send(res, 400, { error: 'bad-coords', msg: '坐标非法' });
        /* GeoAPI 坐标查询为 '经度,纬度'（与天气路径相反）——具名转换，集中在此 */
        return proxyQweather(res, '/geo/v2/city/lookup', { location: lonLatForGeoLookup(ll), number: 8 });
      }
      return send(res, 400, { error: 'bad-request', msg: '需要 name 或 lon/lat 参数' });
    }

    if ((u.pathname === '/api/weather/current' || u.pathname === '/api/weather/daily') && req.method === 'POST') {
      if (!checkKey(req)) return unauthorized(res);
      if (!checkWeather(req).ok) return send(res, 429, { error: 'rate-limited', msg: '天气请求太频繁，稍后再试' });
      const body = JSON.parse(await readBody(req));
      const ll = validateLatLon(body);
      if (!ll) return send(res, 400, { error: 'bad-coords', msg: '坐标非法（lat/lon 必须为数值）' });
      /* 新版天气路径为 /{latitude}/{longitude}（纬度在前）——具名转换，绝不手写颠倒 */
      if (u.pathname === '/api/weather/current') return proxyQweather(res, `/weather/v1/current/${latLonForWeatherPath(ll)}`, {});
      return proxyQweather(res, `/weather/v1/daily/${latLonForWeatherPath(ll)}`, { days: 7 });
    }

    return serveStatic(req, res, u.pathname);
  } catch (e) {
    return send(res, 500, { error: 'server-error', msg: String((e && e.message) || e) });
  }
});

server.listen(CFG.port, () => {
  console.log(`植伴代理已启动: http://127.0.0.1:${CFG.port}`);
  console.log(`  静态前端: http://127.0.0.1:${CFG.port}/          手机同 Wi-Fi: http://<本机IP>:${CFG.port}`);
  console.log(`  联通检查: http://127.0.0.1:${CFG.port}/api/health`);
  console.log(`  视觉: ${CFG.mockVision ? '演示模式（固定示例返回，非真实识别）' : (CFG.zhipuKey ? 'GLM-4.6V（已配置密钥）' : '未配置（server/.env 填写 ZHIPU_API_KEY）')}`);
  console.log(`  天气: ${(CFG.zwHost && CFG.zwKey) ? '和风（已配置）' : '未配置（QWEATHER_API_HOST / QWEATHER_KEY）'}`);
});
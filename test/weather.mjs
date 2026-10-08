// ============================================================
// test/weather.mjs — 天气适配层与引擎条件（v4 §5 / §7.6）
// 运行：node test/weather.mjs（由 run-all.mjs 统一调度）
//
// 覆盖：
//   N 单位与诚实原则：数字归一 / 真实 0≠缺失 / 观测时间不冒充
//   C 缓存：新鲜命中不再发请求；请求失败回退过期缓存并明示 stale
//   E 错误分类：unconfigured / auth / rate-limit / unreachable
//   X 引擎条件差异（指令 §7.6）：同一天气下 露天/室内/未登记 差异化，
//      室外下雨绝不等于室内盆土已湿；无缓存回退季节参考。
// ============================================================
import * as W from '../js/weather.js';
import * as S from '../js/store.js';
import * as E from '../js/engine.js';
import * as K from '../js/knowledge.js';

const mem = {};
globalThis.localStorage = {
  getItem: k => (k in mem) ? mem[k] : null,
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
globalThis.fetch && delete globalThis.fetch;   // 确保走注入

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};

const FAKE_NOW = Date.now();   // 缓存新旧判定基于 at 与真实时钟的差——用真实当前时间，缓存始终新鲜
const FAKE_CITY = { name: '杭州', province: '浙江', zone: '江南', qw: { id: '101010100', lat: 30.29, lon: 120.16 } };

/* ---------- fetch 注入 ---------- */
let mode = 'current-ok';
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  if (mode === 'throw') { const e = new Error('net down'); throw e; }
  const resp = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });
  if (u.includes('/api/weather/current')) {
    if (mode === 'unconfigured') return resp({ error: 'qweather-unconfigured', msg: '缺凭证' }, false, 503);
    if (mode === 'auth') return resp({ error: 'qweather-auth', msg: '鉴权失败' }, false, 401);
    if (mode === 'ratelimit') return resp({ error: 'qweather-rate-limit', msg: '限流' }, false, 429);
    if (mode === 'current-zero') return resp({ ok: true, fetchedAt: FAKE_NOW, data: { now: { temp: '0', humidity: '0', precip: '0.0', text: '晴', obsTime: 'T0' } } });
    if (mode === 'current-missing') return resp({ ok: true, fetchedAt: FAKE_NOW, data: { now: { text: '阴' } } });
    return resp({ ok: true, fetchedAt: FAKE_NOW, data: { now: { temp: '26', humidity: '48', windSpeedKmh: '5.2', precip: '1.8', text: '小雨', obsTime: '2026-10-07T14:30' } } });
  }
  if (u.includes('/api/weather/daily')) {
    return resp({ ok: true, fetchedAt: FAKE_NOW, data: { daily: [
      { fxDate: '2026-10-07', textDay: '小雨', tempMax: '22', tempMin: '18', precip: '4', precipProb: '85' },
      { fxDate: '2026-10-08', textDay: '雨', tempMax: '21', tempMin: '17', precip: '6', precipProb: '90' },
      { fxDate: '2026-10-09', textDay: '多云', tempMax: '23', tempMin: '17' },          // precip 缺失 → null（≠0）
      { fxDate: '2026-10-10', textDay: '晴', tempMax: '24', tempMin: '16', precip: '0', precipProb: '0' },
    ] } });
  }
  if (u.includes('city-lookup')) {
    return resp({ ok: true, fetchedAt: FAKE_NOW, data: { location: [
      { id: '101010100', name: '杭州', adm1: '浙江', adm2: '杭州', lat: '30.29', lon: '120.16', tz: 'Asia/Shanghai' },
    ] } });
  }
  throw new Error('unexpected fetch: ' + u);
};

const fam = S.addFamily({ name: 'W家', city: FAKE_CITY });

/* ---------- N 单位与诚实原则 ---------- */
console.log('N 单位归一与诚实原则');
{
  calls = 0; mode = 'current-ok';
  const r = await W.currentFor(fam);
  check('N1 数字归一（字符串→Number；观测时间保留）', r.status === 'ok' && r.data.tempC === 26 && typeof r.data.windKmh === 'number' && r.data.obsTime === '2026-10-07T14:30', JSON.stringify(r.data));
  check('N1b 降水 1.8mm 归一', r.data.precipMm === 1.8);
  calls = 0; mode = 'current-zero';
  const z = await W.currentFor(fam, { force: true });
  check('N2 真实 0 值保持 0（0 ≠ 缺失）', z.data.tempC === 0 && z.data.humidityPct === 0 && z.data.precipMm === 0, JSON.stringify(z.data));
  calls = 0; mode = 'current-missing';
  const m2 = await W.currentFor(fam, { force: true });
  check('N3 缺失字段是 null（不冒充 0）', m2.data.tempC === null && m2.data.precipMm === null && m2.data.text === '阴', JSON.stringify(m2.data));
  calls = 0; mode = 'current-ok';
}

/* ---------- C 缓存与过期回退 ---------- */
console.log('C 缓存与过期');
{
  await W.currentFor(fam, { force: true }); calls = 0;
  const c2 = await W.currentFor(fam);
  check('C1 新鲜缓存命中（不再发请求）', c2.status === 'ok' && calls === 0, 'calls=' + calls);
  mode = 'throw'; calls = 0;
  const c3 = await W.currentFor(fam, { force: true });
  check('C2 请求失败回退过期缓存并标 stale（不冒充新数据）', c3.status === 'ok' && c3.stale === true && /过期/.test(c3.note || ''), JSON.stringify({ stale: c3.stale, note: c3.note }));
  mem['zhiban:weather-cache'] = '{}'; calls = 0;
  const c4 = await W.currentFor(fam);
  check('C3 无缓存+不可达 → 如实错误 unreachable', c4.status === 'error' && c4.error === 'unreachable', JSON.stringify(c4));
  mode = 'current-ok';
}

/* ---------- E 错误分类 ---------- */
console.log('E 错误分类');
{
  for (const [m, want] of [['unconfigured', 'qweather-unconfigured'], ['auth', 'qweather-auth'], ['ratelimit', 'qweather-rate-limit']]) {
    mem['zhiban:weather-cache'] = '{}'; mode = m;
    const r = await W.currentFor(fam);
    check(`E ${want} 如实返回`, r.status === 'error' && r.error === want, JSON.stringify(r));
  }
  const s1 = await W.searchCity('杭州');
  check('E 城市搜索在无缓存时也可用（拿省市区）', s1.status === 'ok' && s1.candidates[0].name === '杭州' && s1.candidates[0].adm1 === '浙江');
}

/* ---------- X 引擎条件差异（§7.6：室外下雨≠室内盆土湿） ---------- */
console.log('X 引擎条件差异');
{
  // 恢复正常实况并装好缓存（雨）
  mode = 'current-ok';
  await W.currentFor(fam, { force: true });
  await W.dailyFor(fam, { force: true });
  check('X0 预报雨天数计算（近3天=2）', W.rainDays(W.freshDaily(fam), 3) === 2, String(W.rainDays(W.freshDaily(fam), 3)));

  const outYard = S.addSpace({ homeId: fam.id, name: '露天阳台', exposure: '半室外', rain: '会淋雨', light: '有直射光' });
  const inRoom = S.addSpace({ homeId: fam.id, name: '客厅', exposure: '室内', rain: '基本不淋雨', light: '靠窗' });
  const shelter = S.addSpace({ homeId: fam.id, name: '封闭窗台', exposure: '半室外', rain: '基本不淋雨', light: '靠窗' });
  const yuejiOut = S.addPlant({ familyId: fam.id, name: '月季·外', knowledgeKey: 'yueji', spaceId: outYard.id });
  const lvluoIn = S.addPlant({ familyId: fam.id, name: '绿萝·内', knowledgeKey: 'lvluo', spaceId: inRoom.id });
  S.addPlant({ familyId: fam.id, name: '月季·封闭窗台', knowledgeKey: 'yueji', spaceId: shelter.id });
  S.setPref('homeId', fam.id);

  const items = E.weeklyItems();
  const out = items.filter(i => i.plant.id === yuejiOut.id);
  const inn = items.filter(i => i.plant.id === lvluoIn.id);
  check('X1 同天雨下：露天月季收到「正在下雨」weather 条目', out.some(i => i.evidence === 'weather' && /下雨/.test(i.title)), out.map(i => i.evidence + ':' + i.title).join('|'));
  check('X2 室内绿萝不因天气收到任何雨淋条目（盆土仍按各自检查）', !inn.some(i => i.evidence === 'weather' && /下雨|淋/.test(i.title)), inn.map(i => i.evidence + ':' + i.title).join('|'));
  const sheltered = items.filter(i => i.plant.id === S.listPlants().find(p => p.name === '月季·封闭窗台').id);
  check('X3 已登记「基本不淋雨」的半室外位置不误收「还没登记」提示（v4 修复）', !sheltered.some(i => i.evidence === 'weather' && /淋不淋得到|还没登记/.test(i.cond)), sheltered.map(i => i.title).join('|'));
  check('X4 weather 证据标签注册', E.EVIDENCE_LABEL.weather === '天气实况');
  mem['zhiban:weather-cache'] = '{}';       // 清缓存：回到季节参考（不冒充）
  const items2 = E.weeklyItems();
  check('X5 无天气缓存回季节参考（不冒充实况）', !items2.some(i => i.evidence === 'weather') && items2.length === items.length,
    `before=${items.length} after=${items2.length}`);
}

console.log('');
console.log(`天气适配与引擎条件回归：通过 ${pass} / 失败 ${fails.length}`);
fails.forEach(f => console.log('  FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
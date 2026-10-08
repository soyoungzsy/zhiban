// ============================================================
// test/engine-space.mjs — 空间建议引擎对照测试
// 运行：node test/engine-space.mjs
// 覆盖 v3: T07（名称不推断）、T08（同名阳台仅适用者收雨淋）、
//          T09（候选先排除低温等已知限制）、T10（个体差异只影响该盆）、
//          T22（合适不凑建议 / 无更合适位置不虚构）。
// ============================================================
import * as S from '../js/store.js';
import * as E from '../js/engine.js';
import * as K from '../js/knowledge.js';

// ---- 测试环境（Node 无 DOM/localStorage：内存 mock）----
const mem = {};
globalThis.localStorage = {
  getItem: k => (k in mem) ? mem[k] : null,
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; },
};
globalThis.window = {};

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};

/* 造景：一个家（杭州·江南）+ 四个位置 + 六盆植物 */
console.log('S0 布景');
const fam = S.addFamily({ name: '我家', city: { name: '杭州', province: '浙江', zone: '江南' } });
const spLu = S.addSpace({ homeId: fam.id, name: '阳台', exposure: '半室外', rain: '会淋雨', light: '有直射光' });      // 露天南阳台
const spFeng = S.addSpace({ homeId: fam.id, name: '阳台', exposure: '室内', rain: '基本不淋雨', light: '靠窗', note: '封闭窗台，冬天不开窗' }); // 同名封闭
const spLang = S.addSpace({ homeId: fam.id, name: '走廊', exposure: '室内', light: '' });                                // 仅名称，环境未知
const spWin = S.addSpace({ homeId: fam.id, name: '客厅窗边', exposure: '室内', light: '靠窗' });

const yuejiLu = S.addPlant({ familyId: fam.id, name: '月季（露天）', knowledgeKey: 'yueji', spaceId: spLu.id });
const yuejiFeng = S.addPlant({ familyId: fam.id, name: '月季（封闭）', knowledgeKey: 'yueji', spaceId: spFeng.id });
const moliLang = S.addPlant({ familyId: fam.id, name: '茉莉（走廊）', knowledgeKey: 'moli', spaceId: spLang.id });
const moliWin = S.addPlant({ familyId: fam.id, name: '茉莉（窗边）', knowledgeKey: 'moli', spaceId: spWin.id });
const duorouShade = S.addPlant({ familyId: fam.id, name: '多肉（里侧阴影）', knowledgeKey: 'duorou', spaceId: spFeng.id, micro: '放在里侧，基本晒不到' });
const duorouSun = S.addPlant({ familyId: fam.id, name: '多肉（同位置正常）', knowledgeKey: 'duorou', spaceId: spFeng.id });
const lvluoWin = S.addPlant({ familyId: fam.id, name: '绿萝（窗边）', knowledgeKey: 'lvluo', spaceId: spWin.id });

/* T07：仅位置名称、环境为空 → 不推断，评估为未知 */
console.log('T07 仅名称不推断（走廊）');
check('空间光照等级=unknown（非高光照）', E.spaceLightLevel(spLang, moliLang) === 'unknown',
  '实际 ' + E.spaceLightLevel(spLang, moliLang));
{
  const pa = E.positionAssess(moliLang, spLang, K.findKnowledge('moli'), E.seasonContext(fam));
  check('走廊评估=unknown 且文案明说不猜', pa.verdict === 'unknown' && pa.text.includes('不猜'), JSON.stringify(pa).slice(0, 80));
  const items = E.weeklyItems().filter(i => i.plant.id === moliLang.id);
  check('走廊植物不产生位置失配推送', !items.some(i => /位置/.test(i.title) || /光照对它/.test(i.title)));
}

/* T08：两个同名"阳台"，一个封闭一个露天 → 雨淋建议只作用于适用者 */
console.log('T08 同名阳台、不同属性');
{
  const items = E.weeklyItems();
  const lu = items.filter(i => i.plant.id === yuejiLu.id);
  const feng = items.filter(i => i.plant.id === yuejiFeng.id);
  check('露天月季收到"下雨天看看"条目', lu.some(i => /下雨天看看/.test(i.title)), lu.map(i => i.title).join('|'));
  check('封闭阳台月季不收雨淋条目', !feng.some(i => /下雨天看看/.test(i.title)), feng.map(i => i.title).join('|'));
  check('室内盆不因雨被误判打湿（按登记属性分流）', lu.some(i => /会淋雨/.test(i.cond)) && !feng.some(i => i.cond.includes('会淋雨')));
}

/* T09：候选位置先排除已知低温限制（冬季不推"搬到室外更通风"） */
console.log('T09 候选排除已知限制');
{
  const winterCtx = { zone: '江南', season: '冬', city: '杭州', province: '浙江' };
  const pa = E.positionAssess(moliWin, spWin, K.findKnowledge('moli'), winterCtx);  // 茉莉×窗边散射光 → 失配
  check('冬季评估不为它推荐露天阳台', pa.alternative === null || pa.alternative.spaceName !== '阳台', JSON.stringify(pa.alternative));
  check('无候选时明说"暂无更合适"（不虚构）', pa.text.includes('暂无更合适'), pa.text.slice(-60));
  // 同一株在秋季（真实 10 月）评估：露天阳台 direct=fit 且 moli 不怕雨 → 可作为候选
  const autumnCtx = { zone: '江南', season: '秋', city: '杭州', province: '浙江' };
  const pa2 = E.positionAssess(moliWin, spWin, K.findKnowledge('moli'), autumnCtx);
  check('秋季同一位置可推荐露天阳台（前提变化）', pa2.alternative && pa2.alternative.spaceName === '阳台', JSON.stringify(pa2.alternative));
}

/* T10：个体差异 micro 只影响该盆，不改共享空间与其他植物 */
console.log('T10 个体差异只影响该盆');
{
  check('里侧个体被识别为低光', E.spaceLightLevel(spFeng, duorouShade) === 'low');
  check('同位置正常个体仍为靠窗散光', E.spaceLightLevel(spFeng, duorouSun) === 'bright-indirect');
  const paShade = E.positionAssess(duorouShade, spFeng, K.findKnowledge('duorou'), E.seasonContext(fam));
  const paSun = E.positionAssess(duorouSun, spFeng, K.findKnowledge('duorou'), E.seasonContext(fam));
  check('阴影个体=失配提示出现', paShade.verdict === 'mismatch', paShade.verdict);
  check('正常个体=明亮散光对多肉也不够直射但属于改善级', paSun.verdict === 'improve' || paSun.verdict === 'mismatch', paSun.verdict);
  const items = E.weeklyItems();
  const shadeItems = items.filter(i => i.plant.id === duorouShade.id);
  const sunItems = items.filter(i => i.plant.id === duorouSun.id);
  check('阴影个体的周条目含位置提示', shadeItems.some(i => /晒不到|里侧|不足|再好一点/.test(i.title + i.cond)), shadeItems.map(i=>i.title).join('|'));
  check('共享空间字段未被个体覆盖改写', S.getSpace(spFeng.id).light === '靠窗' && S.getSpace(spFeng.id).rain === '基本不淋雨');
}

/* T22：位置合适 → 直说合适不凑建议；无更合适位置不硬选 */
console.log('T22 合适直说 / 不硬选');
{
  const pa = E.positionAssess(lvluoWin, spWin, K.findKnowledge('lvluo'), E.seasonContext(fam));
  check('绿萝×窗边=fit 且文案"无需调整"', pa.verdict === 'fit' && pa.text.includes('无需调整'), pa.text.slice(0, 50));
  const items = E.weeklyItems().filter(i => i.plant.id === lvluoWin.id);
  check('位置合适的盆不产生位置推送（不凑建议）', !items.some(i => /位置合适|再好一点|不足/.test(i.title)));
}

/* T18 五行小卡：恰好 5 行、含名称、每行 ≤10 可见字符；长昵称自动截安全 */
{
  const c1 = E.makeCard(yuejiLu);
  check('T18 月季小卡 5 行且每行≤10 字（校验零错误）', c1.ok && c1.lines.length === 5 && c1.lines.every(l => E.visibleLen(l) <= 10) && (c1.check || []).length === 0, JSON.stringify(c1.lines));
  const longName = S.addPlant({ familyId: fam.id, name: '一盆朋友送的据说很好养的观叶植物', nickname: '王后绿萝王后绿萝王后', knowledgeKey: 'lvluo' });
  const c2 = E.makeCard(longName);
  check('T18 长昵称截到安全宽度（截断仅修首行、其余四行稳定）', c2.ok && c2.lines.length === 5 && c2.lines.every(l => E.visibleLen(l) <= 10), JSON.stringify(c2.lines));
}

console.log('');

/* T23：v4 修复光照等级四类错误 + 个体差异不跨位置 */
console.log('T23 光照等级：否定/未知/室外默认/个体跨位置');
{
  check('登记"有直射光" → direct（正向回归）', E.spaceLightLevel({ exposure: '室内', light: '有直射光' }, null) === 'direct');
  check('"没有直接晒到的太阳"的否定文本不判 direct（v4 复现）', E.spaceLightLevel({ exposure: '室内', light: '没有直射光' }, null) === 'low', 'light=没有直射光 实测=' + E.spaceLightLevel({ exposure: '室内', light: '没有直射光' }, null));
  const negMicro = E.spaceLightLevel({ exposure: '室内', light: '' }, { env: { micro: '不在阴影里' } });
  check('micro "不在阴影里"不判低光（否定无效线索→unknown）', negMicro === 'unknown', '实测=' + negMicro);
  const outsideBlank = E.spaceLightLevel({ exposure: '室外', light: '' }, null);
  check('室外且光照未登记 → unknown，不再默认 direct（v4 复现）', outsideBlank === 'unknown', '实测=' + outsideBlank);
  const matchMicro = E.spaceLightLevel({ exposure: '室内', light: '' }, { env: { micro: '里侧晒不到' } });
  check('micro 肯定描述仍生效（里侧晒不到 → low）', matchMicro === 'low');
  // 跨位置比较：候选评估不携带当前盆 micro
  const altLevel = E.spaceLightLevel(spLu, { env: { micro: '放在里侧，基本晒不到' } }, { includeMicro: false });
  const curLevel = E.spaceLightLevel(spFeng, duorouShade);
  check('candidate 评估忽略个体 micro（planta 带过去不污染新位置）', altLevel === E.spaceLightLevel(spLu, null) && curLevel === 'low', `alt=${altLevel} cur=${curLevel}`);
}

console.log(`空间引擎对照测试：通过 ${pass} / 失败 ${fails.length}` + (fails.length ? ' -> ' + fails.join('; ') : ''));
process.exitCode = fails.length ? 1 : 0;
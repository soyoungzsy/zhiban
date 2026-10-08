// ============================================================
// test/say-rules.mjs — 语音整理规则行为回归（v3 §6 / T15）
// 运行：node test/say-rules.mjs
// 覆盖：
//   · 否定与更正："不是露天阳台，是封闭的" → 空间更正，不当植物名
//   · 未来意愿："明天想搬到客厅" → 只记计划，不当作已发生
//   · 临时拍照："拿到桌上拍照还是放阳台" → 不改长期位置（T12）
//   · 模糊指向："这两盆……另一盆……" → 不批量误改（T15）
//   · 浇水话："昨天浇过水" → 不建任何流水账
//   · 空间更正共享字段：确认（apply）后才生效（T11）
//   · 名字更正与观察语气保留（回归）
// ============================================================
import * as S from '../js/store.js';
import { parseSay } from '../js/views/say.js';

// ---- 测试环境 ----
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
const types = changes => changes.map(c => c.type);

/* 造景：一个家 + 阳台(露天) + 客厅窗边 + 一盆月季在阳台 */
console.log('S0 造景');
const fam = S.addFamily({ name: '我家', city: { name: '杭州', province: '浙江', zone: '江南' } });
const spYt = S.addSpace({ homeId: fam.id, name: '阳台', exposure: '室外', rain: '会淋雨', light: '有直射光' });
S.addSpace({ homeId: fam.id, name: '客厅窗边', exposure: '室内', light: '靠窗' });
const plant = S.addPlant({ familyId: fam.id, name: '月季', knowledgeKey: 'yueji', spaceId: spYt.id });

console.log('V1 v3 核心示例：否定+更正+模糊指向');
{
  const ch = parseSay('不是露天阳台，是封闭的；这两盆在里面，另一盆才在走廊。', plant);
  const t = types(ch);
  check('不被改名为"封闭的"', !t.includes('identity') && !t.includes('rename'), t.join('|'));
  check('多盆指代 → 生成"指代不明确"说明', t.includes('ambiguous'), t.join('|'));
  check('对位置的更正仍被整理（空间环境 diff）', t.includes('space-env'), t.join('|'));
  const env = ch.find(c => c.type === 'space-env');
  check('更正内容：封闭 → 少开窗+室内', env && (env.to.includes('很少开窗') && env.to.includes('室内')), env && env.to);
  check('不产生位置改挂（未指认这盆去哪）', !t.includes('space'), t.join('|'));
}

console.log('V2 空间更正：确认(apply)后才生效（T11）');
{
  const before = S.getSpace(spYt.id);
  const ch = parseSay('阳台是封闭的，冬天基本不开窗', plant);
  const env = ch.find(c => c.type === 'space-env');
  check('diff 存在且先不变', !!env && S.getSpace(spYt.id).air === before.air);
  env.apply();
  const after = S.getSpace(spYt.id);
  check('apply 后共享字段更新（惠及该位置所有盆）', after.air === '很少开窗' && after.exposure === '室内', JSON.stringify(after).slice(0, 80));
  // 另一盆同位置植物也复用（字段是共享的，由 store 保证）
}

console.log('V3 未来意愿：不当作已发生');
{
  const sidBefore = plant.spaceId;
  const ch = parseSay('明天想把它搬到客厅里去', plant);
  const t = types(ch);
  check('生成"未来打算"diff', t.includes('plan'), t.join('|'));
  check('不产生位置改挂', !t.includes('space'), t.join('|'));
  const plan = ch.find(c => c.type === 'plan');
  plan.apply();
  check('apply 只记备注，位置不变', plant.spaceId === sidBefore && plant.notes.some(n => /计划/.test(n.text)));
}

console.log('V4 临时拍照：不改长期位置（T12）');
{
  const sidBefore = plant.spaceId;
  const ch = parseSay('刚才拿到桌上拍照，还是放阳台', plant);
  const t = types(ch);
  check('生成"临时拍照"说明', t.includes('ignore-temp'), t.join('|'));
  check('不把"放阳台"当作变更', !t.includes('space'), t.join('|'));
  ch.forEach(c => c.apply());
  check('apply 后位置保持不变', plant.spaceId === sidBefore);
}

console.log('V5 浇水话：不建任何流水（T15/红线）');
{
  const n0 = S.listObservations(plant.id).length;
  const note0 = plant.notes.length;
  const ch = parseSay('昨天浇过水了', plant);
  const t = types(ch);
  check('生成"不生成记录"说明 diff', t.includes('water-info'), t.join('|'));
  check('不产生观察/身份/位置变更', !t.includes('obs') && !t.includes('identity') && !t.includes('space') && !t.includes('rename'), t.join('|'));
  ch.forEach(c => c.apply());
  check('apply 后观察与备注数量不变', S.listObservations(plant.id).length === n0 && plant.notes.length === note0);
}

console.log('V6 实际位置变更：挂空间档案（同名复用/缺则轻建）');
{
  const ch = parseSay('搬到客厅窗边了', plant);
  const sp = ch.find(c => c.type === 'space');
  check('生成位置 diff', !!sp, types(ch).join('|'));
  sp.apply();
  check('挂到已登记的「客厅窗边」', plant.spaceId !== spYt.id && (S.getSpace(plant.spaceId) || {}).name === '客厅窗边');
  const ch2 = parseSay('挪到走廊了', plant);   // 未登记过的位置
  const sp2 = ch2.find(c => c.type === 'space');
  check('未登记位置 → 新建共享位置', !!sp2 && (sp2.label.includes('新建') || sp2.to.includes('名字建一条')), sp2 && sp2.label + ' / ' + sp2.to);
  sp2.apply();
  const alley = S.getSpace(plant.spaceId);
  check('新位置落库且植物挂上（名字即可，环境默认未知不瞎猜）', alley && alley.name === '走廊' && alley.exposure === '未知' && alley.light === '');
}

console.log('V7 名字更正回归 + 观察语气保留');
{
  const ch = parseSay('这不是月季，是茉莉', plant);
  const idf = ch.find(c => c.type === 'identity');
  check('名字更正正常工作（回归）', !!idf && idf.key === 'moli', types(ch).join('|'));
  idf.apply();
  check('apply 后知识档案切换', plant.knowledgeKey === 'moli' && plant.name === '茉莉');
  const ch2 = parseSay('好像长了几个花苞', plant);
  const obs = ch2.find(c => c.type === 'obs');
  check('观察 diff 保留原话', !!obs && obs.to.includes('好像'), types(ch2).join('|'));
  obs.apply();
  const o = S.listObservations(plant.id)[0];
  check('不确定语气未丢失（uncertain=true，不用"已进入花期"改写）', o.uncertain === true && o.tags.includes('bud'));
}

console.log('V8 家庭话术：单家庭说明（不改数据）');
{
  const ch = parseSay('这盆其实在妈妈家', plant);
  const t = types(ch);
  check('只给说明性 diff', t.includes('home-info') && t.length === 1, t.join('|'));
  ch.forEach(c => c.apply());
  check('apply 后家庭归属不变', plant.familyId === fam.id);
}

console.log('');

console.log('V9 v4 语义回归：否定/疑问/未来/共享空间错写/物种纠正');
{
  const n1 = parseSay('没有黄叶，也没有虫子', plant);
  const t1 = types(n1);
  check('9.1 否定观察不生成 obs（黄叶/虫子都不记成变化）', !t1.includes('obs'), t1.join('|'));
  check('9.1 有可读的否定说明（"没有"就不记）', t1.includes('neg-info'), t1.join('|'));
}
{
  const n2 = parseSay('冬天不开暖气', plant);
  const note2 = n2.find(c => c.type === 'note');
  check('9.2 否定暖气 → 生成备注', !!note2, types(n2).join('|'));
  check('9.2 备注如实"不开暖气"，不反转成会开暖气', note2 && !/会开暖气/.test(note2.to) && /不开暖气|没有暖气/.test(note2.to), note2 && note2.to);
  if (note2) note2.apply();
  check('9.2 apply 后档案确为否定语义', S.getPlant(plant.id).notes.some(n => /不开暖气|没有暖气/.test(n.text) && !/会开暖气/.test(n.text)));
  S.getPlant(plant.id).notes.splice(S.getPlant(plant.id).notes.findIndex(n => /不开暖气/.test(n.text)), 1);
}
{
  S.updatePlant(plant.id, { spaceId: spYt.id });   // V6 已把 plant 挪去「走廊」；9.3 明确挂回阳台再测"这个位置"
  const before3 = S.getSpace(spYt.id).rain;
  const n3 = parseSay('这个位置不会淋雨', plant);
  const env3 = n3.find(c => c.type === 'space-env');
  check('9.3 "不会淋雨"→更正为基本不淋雨（不误写会淋雨）', !!env3 && /基本不淋雨/.test(env3.to), env3 && env3.to);
  if (env3) env3.apply();
  check('9.3 apply 后 space.rain=基本不淋雨', S.getSpace(spYt.id).rain === '基本不淋雨', `before=${before3} after=${S.getSpace(spYt.id).rain}`);
  S.updateSpace(spYt.id, { rain: '会淋雨' });   // 复原，供后续用例
}
{
  const n4 = parseSay('以后会开花吗', plant);
  const t4 = types(n4);
  check('9.4 疑问+未来不生成 flower 观察记录', !t4.includes('obs'), t4.join('|'));
  check('9.4 有说明性回应（不瞎猜花期）', t4.includes('future-question') || t4.includes('neg-info'), t4.join('|'));
}
{
  const before5 = S.getSpace(spYt.id).rain;
  const n5 = parseSay('明天想搬到露天阳台', plant);
  const t5 = types(n5);
  check('9.5 识别为未来意愿（plan 备注）', t5.includes('plan'), t5.join('|'));
  n5.forEach(c => c.apply && c.apply());
  check('9.5 未来意愿不改当前共享空间雨淋（v4 复现 bug 修复）', !t5.includes('space-env') && S.getSpace(spYt.id).rain === before5, `rain=${S.getSpace(spYt.id).rain} types=${t5.join('|')}`);
}
{
  const lord = S.addPlant({ familyId: fam.id, name: '绿萝', knowledgeKey: 'lvluo' });
  const n6 = parseSay('这不是绿萝，是玉树', lord);
  const idm = n6.find(c => c.type === 'identity' || c.type === 'rename');
  check('9.6 库外物种纠正 → 生成更正 diff', !!idm, types(n6).join('|'));
  if (idm) idm.apply();
  const fixed = S.getPlant(lord.id);
  check('9.6 apply 后 knowledgeKey=null（不再生成绿萝养护卡）', fixed.knowledgeKey === null, `k=${fixed.knowledgeKey}`);
  check('9.6 名称更正为玉树', /玉树/.test(fixed.name), fixed.name);
}
{
  S.addSpace({ homeId: fam.id, name: '阳台', exposure: '室内', rain: '基本不淋雨', light: '靠窗', note: '同名第三个' });
  const spKT = S.listSpaces(fam.id).find(x => x.name === '客厅窗边');
  const plant9 = S.addPlant({ familyId: fam.id, name: '消歧测试盆', knowledgeKey: 'lvluo', spaceId: spKT.id });
  const before7 = plant9.spaceId;
  const n7 = parseSay('搬到阳台去', plant9);
  const sp7 = n7.find(c => c.type === 'space');
  check('9.7 同名位置歧义时不自动挂第一个（给消歧说明）', !sp7 || n7.some(c => c.type === 'space-disambig'), types(n7).join('|'));
  n7.forEach(c => c.apply && c.apply());
  check('9.7 apply 后位置未被代改', S.getPlant(plant9.id).spaceId === before7);
}

console.log(`say-rules 回归：通过 ${pass} / 失败 ${fails.length}` + (fails.length ? ' -> ' + fails.join('; ') : ''));
process.exitCode = fails.length ? 1 : 0;
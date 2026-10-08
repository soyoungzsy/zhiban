// ============================================================
// test/health-rules.mjs — 症状推理引擎行为回归
// 运行：node test/health-rules.mjs
// 覆盖 v3：T03（湿土萎蔫三连：不补水/不确诊/不推肥）、
//          T04（未选≠没有、说不清≠否）、T05（追问≤2、可跳过、已知不重问）、
//          水培特例（不走盆土追问）、spot 物种分支与位置语境、结构红线（无百分比）。
// ============================================================
import * as R from '../js/health-rules.js';
import * as K from '../js/knowledge.js';

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (detail ? '  || ' + detail : '')); }
};

console.log('T03 萎蔫 + 盆土偏湿（核心场景）');
const bz = K.findKnowledge('baizhang');
const P = { name: '白掌', identity: { cnName: '白掌' } };
const a1 = R.assess({ plant: P, k: bz, space: null, symTags: ['wilt'], answers: { soil: 'wet' } });
check('方向指向"浇水过多/过湿"排查', a1.direction.title.includes('浇水过多') || a1.direction.title.includes('过湿'), a1.direction.title);
check('明确标注非确诊', a1.direction.text.includes('不是确诊'));
check('第一条动作是"停浇/别浇"', /停浇|别浇|先别浇/.test(a1.actions[0] || ''), JSON.stringify(a1.actions));
check('动作里没有补水建议', !a1.actions.some(a => /先浇点|浇点水试试|补水/.test(a)));
check('明确"先不要施肥"', (a1.avoid || '').includes('施肥'), a1.avoid);
check('有"何时找专业人员"提示', !!a1.escalation);
check('动作不超过 3 条', a1.actions.length >= 1 && a1.actions.length <= 3);

console.log('T03 对偶：盆土偏干');
const a2 = R.assess({ plant: P, k: bz, space: null, symTags: ['wilt'], answers: { soil: 'dry' } });
check('方向为补水', a2.direction.title.includes('补水'), a2.direction.title);
check('建议一次浇透', a2.actions.some(a => /浇透/.test(a)), JSON.stringify(a2.actions));

console.log('T04 未提供/说不清 ≠ 否定');
const a3 = R.assess({ plant: P, k: bz, space: null, symTags: ['wilt'], answers: { soil: 'unsure' } });
const a3txt = a3.direction.text + a3.actions.join('');
check('说不清 → 条件式双分支（先摸土分辨）', /分辨|先摸|偏干.*偏湿|两三厘米/.test(a3txt), a3.direction.title);
check('不强行认定缺水或烂根', !/确诊|一定是|就是缺水/.test(a3txt));
const a4 = R.assess({ plant: P, k: bz, symTags: [] });
check('未选症状 → 引导输入而非编造', a4.needsInput === true);

console.log('T05 追问规则');
const f1 = R.followUpsFor(bz, ['wilt']);
check('萎蔫（土培）触发盆土追问', f1.length === 1 && f1[0].id === 'soil', JSON.stringify(f1.map(f => f.id)));
const f2 = R.followUpsFor(bz, ['wilt', 'yellow-leaf', 'weak']);
check('多症状追问也不超过两题', f2.length <= 2, '实际 ' + f2.length);
check('每题都有"跳过"答案', f2.every(f => f.options.some(o => o.v === 'unsure')));
check('没选萎蔫就不问盆土', !R.followUpsFor(K.findKnowledge('lvluo'), ['yellow-leaf']).some(f => f.id === 'soil'));
check('身份未确认(k=null)的萎蔫也问盆土', R.followUpsFor(null, ['wilt']).some(f => f.id === 'soil'));

console.log('水培特例（富贵竹）');
const fgz = K.findKnowledge('fuguizhu');
check('水培萎蔫不触发盆土追问', !R.followUpsFor(fgz, ['wilt']).some(f => f.id === 'soil'));
const a5 = R.assess({ plant: { name: '富贵竹', identity: {} }, k: fgz, space: null, symTags: ['wilt'], answers: {} });
check('水培萎蔫走水位/水质方向', a5.direction.title.includes('水位'), a5.direction.title);

console.log('spot 物种分支与位置语境');
const yj = K.findKnowledge('yueji');
const spLu = { name: '阳台', rain: '会淋雨', exposure: '半室外', light: '有直射光' };
const a6 = R.assess({ plant: { name: '月季', identity: {} }, k: yj, space: spLu, symTags: ['spot'], answers: {} });
check('月季 spot 用黑斑条目', a6.direction.title.includes('黑斑'), a6.direction.title);
check('动作全部是字符串（无嵌套数组）', a6.actions.every(a => typeof a === 'string' && a.length > 2), JSON.stringify(a6.actions));
check('雨淋位置语境被带入', JSON.stringify(a6).includes('会淋雨') || a6.direction.text.includes('阳台'), a6.direction.text.slice(0, 60));

console.log('结构红线');
const a7 = R.assess({ plant: P, k: bz, space: null, symTags: ['spot'], answers: {} });
const all7 = JSON.stringify(a7);
check('无准确率/百分比数字', !/\d+%/.test(all7));
check('无"根腐病"等确诊病例级措辞', !/根腐病|确诊为/.test(all7));
check('依据行（basis）标注来源', (a7.basis || '').includes('现象') || (a7.basis || '').length > 4, a7.basis);
const a8 = R.assess({ plant: P, k: bz, space: null, symTags: ['other'], answers: {}, freeText: '' });
check('陌生输入不编方向（other 分支稳妥清单）', a8.direction.text.includes('不编造') || a8.direction.text.includes('先做稳妥') || a8.direction.text.includes('没有具体线索'), a8.direction.title);

console.log('');

console.log('E 其他现象：不看内容不再固定"太笼统"（v4 §6.E）');
{
  const e1 = R.assess({ plant: P, k: bz, space: null, symTags: ['other'], answers: {}, freeText: '叶子背面好多白色小虫' });
  check('E1 具体描述→虫向排查', e1.direction.text.includes('虫') && !e1.direction.text.includes('太笼统'), e1.direction.text.slice(0, 40));
  const e2 = R.assess({ plant: P, k: bz, space: null, symTags: ['other'], answers: {}, freeText: '叶子不太对劲' });
  check('E2 模糊描述→只补问最有用的一问', !e2.direction.text.includes('太笼统') && (e2.direction.text.includes('最有用') || e2.direction.text.includes('三个词')), e2.direction.text.slice(0, 40));
  const e3 = R.assess({ plant: P, k: bz, space: null, symTags: ['other'], answers: {}, freeText: '' });
  check('E3 空描述→三词引导且不编造', e3.direction.text.includes('哪里') && !e3.direction.text.includes('太笼统'));
  const e4 = R.assess({ plant: P, k: bz, space: null, symTags: ['other'], answers: {}, freeText: '盆底发臭' });
  check('E4 盆底描述→根盆方向', e4.direction.text.includes('盆底孔') && !e4.direction.text.includes('太笼统'));
  check('E5 任何情况不再出现"太笼统"', [e1, e2, e3, e4].every(r => !r.direction.text.includes('太笼统')));
}

console.log(`health-rules 回归：通过 ${pass} / 失败 ${fails.length}` + (fails.length ? ' -> ' + fails.join('; ') : ''));
process.exitCode = fails.length ? 1 : 0;
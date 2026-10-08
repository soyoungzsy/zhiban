// ============================================================
// engine.js — 建议引擎
//
// 1. seasonContext(family)  城市/地区 → 当前季节语境（标注"季节推测"）
// 2. weeklyItems()          全部植物的「本周照顾重点」
//    分类：check 浇水前检查 / fert 施肥参考 / care 特别照顾 / stage 花期与阶段
//    证据：photo 照片观察 / user 你说的 / season 季节推测 / archive 档案
//    红线：不显示逾期、不要求勾选、不推测用户做过什么；
//          同一植物条目合并（每盆最多 2 条）。
// 3. plantNowTips(plant)    档案页「现在怎么照顾」（1—3 条）
// 4. makeCard(plant)        五行小卡（恰好 5 行、含名称、每行 ≤10 可见字符）
// 5. waterGuidance(plant)   参考间隔 + 现场判断 + 浇水方式（无逐次记录）
// ============================================================

import { findKnowledge, seasonOf, zoneDesc } from './knowledge.js';
import { currentHome } from './home-model.js';
import * as store from './store.js';
import * as weather from './weather.js';   // v4 §5：引擎只读新鲜缓存，不在建议路径上等网络

/* ---------------- 证据与分类标签 ---------------- */

export const CATEGORY_LABEL = { check: '浇水前检查', fert: '施肥参考', care: '特别照顾', stage: '花期与阶段' };
export const EVIDENCE_LABEL = { photo: '照片观察', user: '你说的', season: '季节推测', archive: '档案', weather: '天气实况' };

/** 被视为"问题"的观察标签 */
const PROBLEM_TAGS = new Set(['yellow-leaf', 'brown-tip', 'spot', 'pest', 'wilt', 'drop', 'leggy']);

/* ---------------- 时间格式 ---------------- */

const WD = ['日', '一', '二', '三', '四', '五', '六'];

export function fmtToday(date = new Date()) {
  return `${date.getMonth() + 1}月${date.getDate()}日 · 周${WD[date.getDay()]}`;
}

export function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 相对今天（用于观察时间） */
export function relDay(ts) {
  const now = new Date();
  const a = new Date(ts);
  const oneDay = 86400000;
  const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayStart(now) - dayStart(a)) / oneDay);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return `${diff} 天前`;
  return fmtDay(ts);
}

/* ---------------- 季节语境 ---------------- */

export function seasonContext(family) {
  if (!family || !family.city) return null;
  const zone = family.city.zone;
  return {
    zone,
    season: seasonOf(zone),
    city: family.city.name,
    province: family.city.province,
    zoneDesc: zoneDesc(zone),
  };
}

/* ---------------- 本周照顾重点 ---------------- */

function mkItem(plant, family, ctx, o) {
  return {
    plant, family, ctx,
    category: o.category,
    priority: o.priority,
    title: o.title,
    cond: o.cond || '',
    actions: o.actions || null,
    evidence: o.evidence || 'season',
    stateAt: o.stateAt || null,
    uncertain: !!o.uncertain,
  };
}

/** 观察到的花苞/开花/新芽 → 植物特定的提示语 */
const BUD_HINT = {
  zhizi: '花苞期固定位置别挪动，保持见干见湿，不然容易掉苞。',
  hudielan: '花苞期别挪动位置、别换环境，保持明亮散光。',
  moli: '带花苞的正是新枝；这茬花谢后轻剪一下，还能促下一轮。',
  yueji: '孕蕾期保持见干见湿、光照给足，花苞会陆续打开。',
};
const FLOWER_HINT = {
  moli: '开过一轮后及时剪掉残花，能促发新枝再次开花。',
};
function obsStageHint(k, tag) {
  if (tag === 'bud') return BUD_HINT[k.key] || '花苞期保持现状：光照稳定、见干见湿；别频繁挪动位置。';
  if (tag === 'flower') return FLOWER_HINT[k.key] || '正在开花：正常养护即可，谢了之后及时摘掉残花。';
  return '冒新芽说明长势不错；光照和水跟上就好。';
}

/** 施肥窗口（按季节 + 植物类型；有前提表达，不催促） */
/* ---------------- 摆放位置建议（v3 §4 / §4.5） ----------------
   红线（T07/T09/T22）：
   - 不按位置名称（阳台/走廊）臆测光照通风——只看用户登记的
     exposure / light / rain 与该盆个体 micro 差异；
   - 光照环境未登记就明说"未知"，等用户补充，绝不编造；
   - 位置合适 → 直说合适（不凑建议，T22）；比不出更好的候选
     就明说"暂无更合适的已登记位置"，不虚构用户没有的位置。
   个体差异 micro 只覆盖这一盆，不改共享空间的字段（T10）。 */

/** 空间光照等级（保守；个体 micro 优先）
 *  v4 §4 修复：
 *  - 否定语境不误判——"没有直射光"不因含"直射"两字判成直射；
 *    micro 里"不在阴影里"不因含"阴影"判成低光（否定线索无效，往后按登记判断）。
 *  - exposure='室外' 且光照未登记时不再默认 direct——一律 unknown 等用户登记，
 *    绝不臆测（此前"室外=direct"是把前提当成了事实）。
 *  - includeMicro=false 供跨位置候选比较：不把旧位置的个体差异
 *    （"里侧被挡住"）带到新位置的评估里。 */
export function spaceLightLevel(space, plant, { includeMicro = true } = {}) {
  const micro = includeMicro ? ((plant && plant.env && plant.env.micro) || '') : '';
  const negMicro = /(不在|没有|没在|不是)(阴影|暗处|背光)/.test(micro);
  if (!negMicro) {
    if (/阴影|晒不到|背光|里侧|更暗/.test(micro)) return 'low';
    if (/西晒|更晒|直射/.test(micro)) return 'direct';
  }
  if (!space) return 'unknown';
  const lt = space.light || '';
  const ex = space.exposure || '未知';
  if (/明亮散光|散射光/.test(lt)) return 'bright-indirect';
  if (/靠窗|窗边/.test(lt) && ex !== '室外') return 'bright-indirect';
  if (/无直射|没有直射|没有太阳|没有阳光|不晒|晒不到|背阴|光照一般|阴影/.test(lt)) return 'low';
  if (/有直射光|全日照|太阳直晒/.test(lt)) return 'direct';
  return 'unknown';
}

const LIGHT_MATCH = {
  'full-sun': { direct: 'fit', 'bright-indirect': 'mismatch', low: 'mismatch', unknown: 'unknown' },
  'bright': { direct: 'ok', 'bright-indirect': 'fit', low: 'improve', unknown: 'unknown' },
  'flex-bright': { direct: 'fit', 'bright-indirect': 'fit', low: 'improve', unknown: 'unknown' },
  'part-shade': { direct: 'improve', 'bright-indirect': 'fit', low: 'ok', unknown: 'unknown' },
  'flex': { direct: 'fit', 'bright-indirect': 'fit', low: 'ok', unknown: 'unknown' },
};

/** 从已登记位置找替代候选（只推荐一个；先排除已知限制，T09） */
function bestAlternative(plant, curSpaceId, k, ctx) {
  const spaces = store.listSpaces(plant.familyId).filter(sp => sp.id !== curSpaceId);
  for (const sp of spaces) {
    const level = spaceLightLevel(sp, null, { includeMicro: false });  // v4 修复：候选评估真正不带个体差异（原先传 plant 会把"里侧被挡"带给新位置）
    if (level === 'unknown') continue;
    const rating = (LIGHT_MATCH[k.lightNeed || 'flex'] || LIGHT_MATCH['flex'])[level];
    if (rating !== 'fit') continue;
    // 排除已知明显限制（"通风好"不能压过低温/雨淋/强晒，v3 §4.4/T09）
    if (ctx && ctx.season === '冬' && k.careCold && sp.exposure && sp.exposure !== '室内') continue;
    if (k.rainRisk && sp.rain === '会淋雨') continue;
    if (ctx && ctx.season === '夏' && k.careHot && level === 'direct' && k.lightNeed !== 'full-sun') continue;
    let reason = '光照条件更匹配';
    if (k.lightNeed === 'full-sun' && level === 'direct') reason = '那里晒得到直射光';
    if (ctx && ctx.season === '夏' && sp.exposure === '室外') reason += '；盛夏正午留意遮阴';
    return { space: sp, reason };
  }
  return null;
}

/** 三层位置评估：当前是否合适 / 原位置最小改善 / 必要时家里哪个已登记位置更合适 */
export function positionAssess(plant, space, k, ctx) {
  if (!k) return null;
  if (!space) {
    return {
      verdict: 'no-space', title: '位置还没登记', notes: [],
      text: '这盆还没登记摆放位置。到「摆放位置」页给它选一个（新建一个名字就行）；位置一次登记、多盆复用，建议会带上光照与季节条件。',
      alternative: null,
    };
  }
  const level = spaceLightLevel(space, plant);
  const need = k.lightNeed || 'flex';
  if (level === 'unknown') {
    return {
      verdict: 'unknown', title: `「${space.name}」：光照情况还没登记`, notes: ['位置光照未登记 → 评估为"未知"，不猜测（T07）。'],
      text: `「${space.name}」这个名称本身说明不了光照——不猜。补一条关键信息即可：这个位置平常能不能晒到直射太阳？在「摆放位置」里勾一下（靠窗/有直射光/无直射光），判断会自动跟上。`,
      alternative: null,
    };
  }
  const rating = (LIGHT_MATCH[need] || LIGHT_MATCH['flex'])[level] || 'unknown';
  const notes = [];
  if (level === 'direct' && space.exposure === '室外' && !/有直射光|全日照/.test(space.light || '')) {
    notes.push('按"室外位置通常晒得到直射光"的前提评估；若实情不同（如檐下阴影），请更正位置信息。');
  }
  if (rating === 'fit') {
    return {
      verdict: 'fit', title: `「${space.name}」位置合适`, notes,
      text: `按已登记的环境，${k.name}在「${space.name}」是合适的——无需调整，不用频繁挪动。`,
      alternative: null,
    };
  }
  if (rating === 'ok') {
    return {
      verdict: 'ok', title: `「${space.name}」基本合适`, notes,
      text: '位置基本合适。状态一般的话，留意光照是否还有提升空间。',
      alternative: null,
    };
  }
  if (rating === 'improve' || rating === 'mismatch') {
    const isBad = rating === 'mismatch';
    const improveText = need === 'full-sun'
      ? `${k.name}需要每天晒到几小时直射光，在「${space.name}」明显吃不足：优先考虑挪到家里日光最长、晒得最久的位置`
      : need === 'part-shade' && level === 'direct'
        ? '这里光照偏强：正午适当避开直晒即可，不必搬走'
        : need === 'bright' && level === 'low'
          ? '这个位置对它偏暗：向窗边挪一点会更好'
          : '向窗边或更亮处挪一点，会长得更好';
    const alt = bestAlternative(plant, space.id, k, ctx);
    return {
      verdict: rating,
      title: `「${space.name}」：光${isBad ? '照对它明显不足' : '照还能再好一点'}`,
      notes,
      text: improveText + (alt
        ? `；家里已登记位置中「${alt.space.name}」更合适（${alt.reason}）。`
        : '；家里暂无更合适的已登记位置——需要的话可以先在「摆放位置」新增一个标签再看，不硬选。'),
      alternative: alt ? { spaceName: alt.space.name, reason: alt.reason } : null,
    };
  }
  return { verdict: 'unknown', title: '光照信息不足', text: '暂无法判断位置合适性。', notes, alternative: null };
}

/** 位置带来的条件式留意（v3 §4.5 基础 + v4 §5 天气实况增强）
 *  红线：引擎只读"新鲜"天气缓存（过期数据只在 UI 标注展示，不进建议）；
 *  室外下雨不等于室内盆土已湿——室内盆绝不因天气收雨淋条目；
 *  雨淋未登记的在用户勾选前只给条件式提醒（不硬推断）。 */
function spaceCareItems(plant, family, ctx, k, space) {
  const out = [];
  if (!k || !space) return out;
  const wx = weather.freshCurrent(family);
  const raining = weather.rainingNow(wx);
  const hot = weather.heatNow(wx);
  const obs = wx && wx.obsTime ? `（和风观测 ${wx.obsTime}）` : '（和风实况）';

  if (space.rain === '会淋雨' && k.rainRisk) {
    if (raining) {
      out.push(mkItem(plant, family, ctx, {
        category: 'care', priority: 18,
        title: `外面正在下雨——「${space.name}」这盆淋得到`,
        cond: `室外正在下雨${obs}——这个位置登记为会淋雨。雨后照例检查：叶心不积水、盆底排水通畅、托盘里的水倒掉。室内盆不受影响——室内盆土干湿仍按各自的"先摸土"判断。`,
        evidence: 'weather',
      }));
    } else {
      out.push(mkItem(plant, family, ctx, {
        category: 'care', priority: 33,
        title: `下雨天看看「${space.name}」这盆`,
        cond: `「${space.name}」登记为会淋雨的位置，而${k.name}长期淋雨容易出问题（叶心积水、病害等）。天气预报有雨的日子留意它；雨后检查叶心积水和盆里排水是否顺畅。`,
        evidence: 'archive',
      }));
      const daily = weather.freshDaily(family);
      const rd = weather.rainDays(daily, 3);
      if (rd >= 1) {
        out.push(mkItem(plant, family, ctx, {
          category: 'care', priority: 34,
          title: `预报几天内有雨（约 ${rd} 天）`,
          cond: `和风预报显示近几天约 ${rd} 天有雨——「${space.name}」是会淋雨位置，下雨那几天留心排水；晴后再看叶心是否积水。`,
          evidence: 'weather',
        }));
      }
    }
  } else if (raining && k.rainRisk && space.exposure && space.exposure !== '室内' && (!space.rain || space.rain === '未知')) {
    out.push(mkItem(plant, family, ctx, {
      category: 'care', priority: 36,
      title: `在下雨——「${space.name}」这盆淋不淋得到？`,
      cond: `室外正在下雨${obs}。这个位置不是室内，但"会不会淋到雨"还没登记——淋得到的话照例查排水；到「摆放位置」勾一下"会淋雨/基本不淋雨"，这条以后就能更准确。`,
      evidence: 'weather',
    }));
  }
  if (hot && space.exposure && space.exposure !== '室内' && k.careHot) {
    out.push(mkItem(plant, family, ctx, {
      category: 'care', priority: 35,
      title: `今天 ${wx.tempC}℃ 高温——直晒位置要留心`,
      cond: `和风实况 ${wx.tempC}℃${obs}——「${space.name}」受直晒影响更大：正午留意遮阴、别贴着滚烫的窗玻璃。浇水仍先摸土再定，不因天热就绕过检查。`,
      evidence: 'weather',
    }));
  }
  return out;
}

function fertItem(plant, family, ctx, k) {
  if (!ctx) return null;
  const autumnFertKeys = new Set(['duorou', 'yueji']); // 秋季仍值得施肥参考的种类
  const inWindow = (ctx.season === '春' || ctx.season === '夏') || (ctx.season === '秋' && autumnFertKeys.has(k.key));
  const inRest = ctx.season === '冬';
  if (inRest) return null;
  if (!inWindow) return null;
  return mkItem(plant, family, ctx, {
    category: 'fert',
    priority: ctx.season === '秋' ? 52 : 50,
    title: '施肥参考',
    cond: `${k.fert.principle} 这个生长季施过就不用重复——别因为再次打开应用就加施一次。限制：${(k.fert.limits || []).join('；')}。`,
    evidence: 'season',
  });
}

/** 浇水前检查（夏季喜水类 + 新建档引导； ExpressionCopy 始终是"先检查，满足条件再浇"） */
function checkItems(plant, family, ctx, k) {
  const out = [];
  if (!ctx || !k || !k.water || k.water.mode === 'hydro') return out;
  const summerMax = k.water.interval && k.water.interval['夏'] ? k.water.interval['夏'][1] : null;
  const hotThirsty = ctx.season === '夏' && summerMax !== null && summerMax <= 5;
  if (hotThirsty) {
    out.push(mkItem(plant, family, ctx, {
      category: 'check',
      priority: 55,
      title: '先摸盆土，再决定浇水',
      cond: `高温期它耗水快，也可能一两天盆面就干了。先检查：${k.water.check} 满足条件再浇；不满足就别浇。`,
      evidence: 'season',
    }));
  }
  const daysNew = (Date.now() - plant.createdAt) / 86400000;
  if (daysNew <= 7) {
    out.push(mkItem(plant, family, ctx, {
      category: 'check',
      priority: 58,
      title: '第一周：先认识它的干湿',
      cond: '本周末先摸一次盆土，对照档案里的「现场判断」感受它几天变干；以后照感受浇水，不必记录。',
      evidence: 'archive',
    }));
  }
  return out;
}

function weeklyItemsFor(plant, families) {
  const family = families.find(f => f.id === plant.familyId);
  if (!family) return [];
  const ctx = seasonContext(family);
  const k = findKnowledge(plant.knowledgeKey);
  const space = plant.spaceId ? store.getSpace(plant.spaceId) : null;   // 摆放位置（v3 §4）
  const items = [];

  // 1) 身份待确认：最高优先，且不再叠加知识条目（避免凑数）
  if (plant.identityPending || !k) {
    return [mkItem(plant, family, ctx, {
      category: 'care', priority: 1, title: '身份待确认',
      cond: '补一张带叶子的清晰照片，或在档案里点「说一说」告诉我它的名字，就能得到针对性建议。',
      evidence: 'archive',
    })];
  }

  // 2) 近 30 天有效观察（photo / user 证据；旧照不作当前状态）
  const obs = store.recentObservations(plant.id, 30);
  const seen = new Set();
  for (const o of obs) {
    for (const tag of o.tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      if (PROBLEM_TAGS.has(tag)) {
        const issue = (k.issues || []).find(i => i.tag === tag);
        if (issue) {
          items.push(mkItem(plant, family, ctx, {
            category: 'care',
            priority: (tag === 'pest' || tag === 'spot' || tag === 'wilt') ? 20 : 25,
            title: (o.uncertain ? '疑似：' : '') + issue.title,
            cond: issue.likely,
            actions: issue.actions,
            evidence: o.source === 'photo' ? 'photo' : 'user',
            stateAt: o.stateAt,
            uncertain: o.uncertain,
          }));
        }
      } else if (tag === 'bud' || tag === 'flower' || tag === 'new-shoot') {
        const t = tag === 'bud' ? (o.uncertain ? '疑似看到花苞' : '看到花苞了')
          : tag === 'flower' ? '正在开花' : '冒新芽了';
        items.push(mkItem(plant, family, ctx, {
          category: 'stage', priority: 15, title: t,
          cond: obsStageHint(k, tag),
          evidence: o.source === 'photo' ? 'photo' : 'user',
          stateAt: o.stateAt,
          uncertain: o.uncertain,
        }));
      }
    }
  }

  // 3) 季节阶段（与观察期条目跳重：同月已有 bud/flower 观察的，不再重复挂季节花期）
  const month = new Date().getMonth() + 1;
  const obsHasFlower = seen.has('bud') || seen.has('flower');
  for (const st of (k.stages || [])) {
    if (!st.months.includes(month)) continue;
    const isFlowerStage = /花期|孕蕾/.test(st.title);
    if (isFlowerStage && obsHasFlower) continue;
    items.push(mkItem(plant, family, ctx, {
      category: 'stage', priority: 40, title: st.title, cond: st.text, evidence: 'season',
    }));
  }

  // 4) 季节护理（防冻/防高温；带位置感知，v3 §4.5）
  if (ctx) {
    const outdoorish = space && space.exposure !== '室内';
    if (ctx.season === '冬' && k.careCold) {
      items.push(mkItem(plant, family, ctx, {
        category: 'care', priority: 30, title: '降温防护',
        cond: outdoorish ? `「${space.name}」不在室内，降温时这份位置受影响更大：${k.careCold}` : k.careCold,
        evidence: 'season',
      }));
    } else if (ctx.season === '秋' && k.careCold && ctx.zone === '华北' && month === 11) {
      items.push(mkItem(plant, family, ctx, { category: 'care', priority: 32, title: '寒潮将至的防护', cond: k.careCold, evidence: 'season' }));
    }
    if (ctx.season === '夏' && k.careHot) {
      items.push(mkItem(plant, family, ctx, {
        category: 'care', priority: 45, title: '高温期注意',
        cond: space && space.exposure === '室外' ? `「${space.name}」是室外位置，高温时叠加暴晒风险：${k.careHot}` : k.careHot,
        evidence: 'season',
      }));
    }
    // 5) 施肥窗口
    const fi = fertItem(plant, family, ctx, k);
    if (fi) items.push(fi);
  }

  // 5.5) 摆放位置带来的条件式留意（v3 §4.5：空间真正改变建议）
  items.push(...spaceCareItems(plant, family, ctx, k, space));
  const pa = positionAssess(plant, space, k, ctx);
  if (pa && pa.verdict === 'mismatch') {
    items.push(mkItem(plant, family, ctx, {
      category: 'care', priority: 42, title: pa.title, cond: pa.text, evidence: 'archive',
    }));
  }

  // 6) 浇水前检查
  items.push(...checkItems(plant, family, ctx, k));

  // 同类合并（每类只保留最优先一条）
  const byCat = new Map();
  for (const it of items) {
    if (!byCat.has(it.category) || byCat.get(it.category).priority > it.priority) byCat.set(it.category, it);
  }
  const merged = [...byCat.values()].sort((a, b) => a.priority - b.priority);

  // 每盆最多 2 条（同一植物的重复提醒合并掉）
  return merged.slice(0, 2);
}

/** 全部植物的本周重点（已排序、已合并） */
export function weeklyItems() {
  // 单家庭（v3 §5）：首页重点只看"我的家"的植物；归档家庭数据不参与推送
  const home = currentHome();
  const plants = home ? store.listPlants().filter(p => p.familyId === home.id) : [];
  const families = store.listFamilies();
  const all = [];
  for (const p of plants) all.push(...weeklyItemsFor(p, families));
  all.sort((a, b) => a.priority - b.priority);
  return all;
}

/** 档案页「现在怎么照顾」：该盆 1—3 条 */
export function plantNowTips(plantId) {
  const plant = store.getPlant(plantId);
  if (!plant) return [];
  const families = store.listFamilies();
  return weeklyItemsFor(plant, families);
}

/** 首页植物卡片的单条提示 */
export function plantTileTip(plant) {
  const tips = plantNowTips(plant.id);
  if (tips.length) return tips[0].title + (tips[0].cond ? '——' + firstSentence(tips[0].cond) : '');
  const k = findKnowledge(plant.knowledgeKey);
  if (!k) return '待确认身份后可给出养护建议';
  return k.intro;
}

function firstSentence(s) {
  const m = String(s || '').match(/^[^。！？；;]+/);
  return (m ? m[0] : s).slice(0, 42);
}

/* ---------------- 浇水指导（参考间隔 + 现场判断 + 方式） ---------------- */

export function waterGuidance(plant, family) {
  const k = findKnowledge(plant.knowledgeKey);
  if (!k || !k.water) return null;
  const ctx = seasonContext(family);
  const season = ctx ? ctx.season : null;
  const iv = k.water.interval;
  const seasonRange = season && iv ? iv[season] : null;
  return {
    mode: k.water.mode || 'soil',
    principle: k.water.principle,
    intervals: iv || null,
    intervalText: seasonRange
      ? `约 ${seasonRange[0]}—${seasonRange[1]} 天一次（${ctx.city}当前季节「${season}」的室内参考范围，不是必须执行的日程）`
      : null,
    intervalCondition: k.water.intervalCondition,
    check: k.water.check,
    how: k.water.how,
    warn: k.water.warn,
    seasonNote: k.water.mode === 'hydro'
      ? '水培植物看水位与水质，不适用"几天一次"。'
      : (season ? null : '未设置城市时，无法按季节选择参考范围。'),
  };
}

/* ---------------- 五行养护小卡 ---------------- */

export function visibleLen(s) {
  return String(s || '').replace(/\s/g, '').length;
}

function pickLine(pair) {
  if (!Array.isArray(pair)) return '';
  for (const s of pair) if (visibleLen(s) <= 10 && s) return s;
  return '';
}

/** 生成五行小卡：恰好 5 行；名称行包含在五行内；每行 ≤10 可见字符 */
export function makeCard(plant) {
  const k = findKnowledge(plant.knowledgeKey);
  if (!k) return { ok: false, lines: [], name: '', reason: '身份待确认后才能生成小卡' };

  // 第 1 行：昵称或常用名（≤10；超长时退回知识名）
  let name = plant.nickname || plant.name || k.name;
  if (visibleLen(name) > 10) name = k.name;
  if (visibleLen(name) > 10) name = name.slice(0, 10); // 知识名不会到 10，兜底

  const rows = [
    name,
    pickLine(k.card.light),
    pickLine(k.card.waterWhen),
    pickLine(k.card.waterHow),
    pickLine(k.card.extra),
  ];

  const warnings = [];
  const missing = rows.slice(1).filter(r => !r).length;
  if (missing) warnings.push(`有 ${missing} 行素材缺失，生成保底行`);
  rows.forEach((r, i) => {
    if (visibleLen(r) > 10) warnings.push(`第 ${i + 1} 行超长（${visibleLen(r)} 字），已改用精简档：${r}`);
  });

  // 保底：缺失行用"先看盆土干湿"一类的最小共识（不出现在正常路径）
  const fallback = { 1: '先看光照足否', 2: '先摸盆土干湿', 3: '浇透而别浇半', 4: '宁少勿多浇' };
  for (let i = 1; i < 5; i++) if (!rows[i]) rows[i] = fallback[i];

  return { ok: true, lines: rows, name, warnings, check: validateCard(rows) };
}

/** 硬校验：恰好 5 行、每行 ≤10 可见字符 */
export function validateCard(lines) {
  const errs = [];
  if (!Array.isArray(lines) || lines.length !== 5) errs.push(`必须是 5 行，当前 ${Array.isArray(lines) ? lines.length : 0} 行`);
  (lines || []).forEach((r, i) => { if (visibleLen(r) > 10) errs.push(`第 ${i + 1} 行 ${visibleLen(r)} 字超过 10`); });
  return errs;
}
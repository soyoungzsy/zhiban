// ============================================================
// health-rules.js — 症状排查推理引擎（v3 §3，正式主路径）
//
// 设计原则：
//   · 用户只选"看到的现象"，绝不选病名/原因（3.1）；
//   · 组合推理，不是"一症状 → 一病"：考虑物种、栽培方式（土培/水培）、
//     症状组合、位置档案、追问答案（3.2）；
//   · 未勾选 = 未提供，不当"明确没有"；"说不清" ≠ "否"（T04）；
//   · 每次评估从头计算，不保留旧的冲突条件；
//   · 结果最多给出：一个优先方向 + 1—3 条可执行动作；必要时才
//     "先不要做什么"和就医提示（3.3）——不凑条数；
//   · 不确诊、不给病害百分比、不编造药剂用量（有依据时提示看标签）。
// ============================================================

/* ---------------- 症状清单（现象，非病因） ---------------- */

export const SYMPTOMS = [
  { tag: 'wilt', label: '叶片下垂蔫软', hint: '整片叶子没精神、耷拉下来' },
  { tag: 'yellow-leaf', label: '叶子发黄', hint: '老叶或新叶变黄、失绿' },
  { tag: 'brown-tip', label: '叶尖发焦发干', hint: '叶尖干枯、变褐' },
  { tag: 'spot', label: '有斑点或斑块', hint: '叶面黑点、水渍斑、烂斑' },
  { tag: 'pest', label: '看到虫子', hint: '小虫、蛛网、黏腻东西' },
  { tag: 'drop', label: '掉叶或掉花苞', hint: '没碰它就自己脱落' },
  { tag: 'weak', label: '长势变差', hint: '长得慢、越长越细越稀' },
  { tag: 'other', label: '说不清 / 其他', hint: '没把握归类，说两句看到的' },
];

export function symptomLabel(tag) {
  const s = SYMPTOMS.find(x => x.tag === tag);
  return s ? s.label : tag;
}

/* ---------------- 追问（最多两题、逐题、可跳过） ---------------- */

export const FOLLOWUP_DEFS = [
  {
    id: 'soil',
    when: ({ sym, k }) => sym.has('wilt') && (!k || (k.water && k.water.mode !== 'hydro')),  // 身份未确认也问（多数为土培）
    ask: '顺手摸一下盆土（表面往下两三厘米）：现在是偏湿、偏干，还是说不清？',
    why: '垂蔫既可能是缺水，也可能是浇多了伤根——盆土状态能区分这两条路，答案只用于本次判断',
    options: [
      { v: 'wet', t: '偏湿（潮的，甚至托盘积水）' },
      { v: 'dry', t: '偏干（发干、盆变轻）' },
      { v: 'unsure', t: '说不清 / 先跳过' },
    ],
  },
  {
    id: 'move',
    when: ({ sym }) => sym.has('yellow-leaf') || sym.has('drop') || sym.has('weak'),
    ask: '最近两周，它的位置或环境有过变动吗（挪动、换窗、晒伤、天气突变）？',
    why: '环境突变是掉苞、发黄的常见原因，答案只帮助缩小方向',
    options: [
      { v: 'yes', t: '有变动' },
      { v: 'no', t: '没有变动' },
      { v: 'unsure', t: '没注意 / 跳过' },
    ],
  },
];

/** 依据已选症状生成追问（硬上限两题；可跳过；不问档案里已知的） */
export function followUpsFor(k, symTags) {
  const ctx = { sym: new Set(symTags), k };
  return FOLLOWUP_DEFS.filter(f => f.when(ctx)).slice(0, 2)
    .map(f => ({ id: f.id, ask: f.ask, why: f.why, options: f.options }));
}

/* ---------------- 推理 ---------------- */

const isHydro = k => !!(k && k.water && k.water.mode === 'hydro');

/** 病因未知时的"稳妥检查清单"（兜底，不编方向） */
function generalObservationActions(k) {
  const acts = ['先别急着浇水施肥或挪位置——一次只改一个变量', '挑一片明显的叶子连续观察 2—3 天：变好、不变还是扩散'];
  if (k && k.water && k.water.check) acts.push(`按「平时怎么养」检查浇水节奏：${k.water.check}（摸土/看根白不白这类，用你的手比什么都准）`);
  return acts.slice(0, 3);
}

/**
 * 核心评估。
 * @param plant  植物档案
 * @param k      知识条目（可能 null：身份待确认）
 * @param space  摆放位置档案（可能 null）
 * @param symTags 已选症状标签数组
 * @param answers 追问答案 { soil?: 'wet'|'dry'|'unsure', move?: 'yes'|'no'|'unsure' }
 * @param freeText 用户补充描述
 * @returns 结果对象；sel 为空时返回 { needsInput: true, hint }
 */
export function assess({ plant, k, space, symTags = [], answers = {}, freeText = '' }) {
  const sym = new Set(symTags);
  if (!sym.size) {
    return {
      needsInput: true,
      hint: '先选你看到的现象（可以多选、可以"说不清"），或补一句描述——不用知道病名。',
    };
  }

  const basisBits = ['你选择的现象'];
  if (plant && (plant.name || plant.identity?.cnName)) basisBits.push('这盆植物的身份');
  if (space) basisBits.push(`位置档案「${space.name}」`);
  if (answers.soil) basisBits.push('你对盆土的回答');
  if (answers.move) basisBits.push('对最近变动的回答');

  let A = [];
  let direction = null, avoid = null, escalation = null, foldedLike = '', foldedAlt = '';
  let usedSpeciesIssue = false;

  const speciesIssueFor = tag => k && (k.issues || []).find(i => i.tag === tag);

  /* —— 虫害通常优先可观察、可行动 —— */
  if (sym.has('pest')) {
    const iss = speciesIssueFor('pest');
    direction = {
      title: '先处理看得到的虫',
      text: (iss ? iss.likely : '虫子本身容易观察，先按虫处理，比"调环境"见效快。')
        + ' 用药与否、怎么用，以药剂标签为准；本应用不给剂量。',
    };
    A.push(...(iss ? iss.actions.slice(0, 2) : ['少量可先用湿布/水柱清掉，连查 3 天叶背']));
    if (iss) usedSpeciesIssue = true;
    foldedAlt = '若虫只在局部、植物状态尚可，也可先物理清除观察几天再考虑用药。';
    if (sym.has('spot') || sym.has('yellow-leaf')) {
      foldedLike += '虫害（蚜虫蜜露、红蜘蛛刺吸）也会造成斑点与失绿——除虫后观察这些是否随之缓解。';
    }
  }

  /* —— 萎蔫：土培按盆土分两路（T03 核心） —— */
  if (sym.has('wilt') && !isHydro(k) && answers.soil === 'wet') {
    direction = {
      title: '先按"浇水过多 / 盆土闷湿"方向排查',
      text: '土偏湿还发蔫，缺水的解释站不住——更可能是根泡闷了吸不上水（S2：蔫 ≠ 缺水）。'
        + '这是一个排查方向，不是确诊。',
    };
    A.push('先别浇水、先别施肥——停几天，让土干一干（托盘积水倒掉，多通风）');
    A.push('几天后仍蔫或加重：等土干后小心脱盆看根——发黑发软的才处理，白根健在就原样种回');
    avoid = '补水"救急"、施肥"促恢复"、反复挪位置——这几件现在都帮不上忙，反而添乱';
    escalation = '如果出现发臭、茎基部发软，根坏死的可能性升高，可找花店或植物网友看图确认';
    foldedLike = '湿土+萎蔫常见于浇水过频繁、盆大土多干得慢、托盘长期积水。多肉、虎皮兰、发财树尤其常见（它们本身耐旱）。';
    foldedAlt = '少数情况：高温天突然暴晒也会蔫（土不缺水）；土久未换、板结，水浇下去也渗不均匀。先按主方向处理 2—3 天再对照。';
  } else if (sym.has('wilt') && !isHydro(k) && answers.soil === 'dry') {
    direction = {
      title: '先补水——按它的正确方式浇透',
      text: `土发干、盆变轻，缺水的解释合理${k ? '' : '（身份未确认，先按通用方式）'}。浇对方式比浇多少重要。`,
    };
    A.push(k && k.water && k.water.how ? `一次浇透：${k.water.how}` : '一次浇透：慢慢浇到盆底流出，托盘积水倒掉');
    A.push('浇后观察 1—2 天：垂叶一般应恢复；不恢复再往根部方向排查');
    foldedLike = '干旱性萎蔫恢复后新叶外观一般正常；反复发生（如出了三天差就蔫）说明土太少/盆太小，考虑换盆。';
    foldedAlt = '若浇透后 2 天仍蔫：根系受伤（曾干透过久或过湿）吸不上水的可能上升，见下一条"根部"描述。';
  } else if (sym.has('wilt') && !isHydro(k)) {
    // 没触发 soil 追问（跳过/未选）→ 两个分支的条件式，不编认定（T04：说不清≠否）
    direction = {
      title: '先摸土再动手：垂蔫有两条相反的路',
      text: '缺水要补水、过湿要停浇——方向相反，先用手分辨再选择，不要"先浇点试试"。',
    };
    A.push(k && k.water ? `用它自己的判断法：${k.water.check}` : '手指插土下两三厘米：偏干→浇透；偏湿→停浇并通风');
    A.push('拿不准就先只观察半天再看——两种原因都不差这半天');
    foldedLike = 'S2：萎蔫既可能是缺水，也可能是长期过湿伤根（此时再浇水只会更糟）。';
    foldedAlt = '高温暴晒、闷根（土板结）也会蔫；处理主方向两天无好转再回来看。';
  } else if (sym.has('wilt') && isHydro(k)) {
    direction = {
      title: '水培蔫头：先看水位和水质',
      text: '水培的蔫通常与水质（发黏发臭）或根发黑有关，不是"缺水"概念。',
    };
    A.push('换水：把根冲一冲，发黑发软的根剪掉，硬白根留下');
    A.push('水位保持没过根 5—10 厘米即可；放散光处避风口');
    foldedLike = '夏季水质坏得快，换水间隔比加水更影响状态。';
  }

  /* —— 斑点：结合位置与季节 —— */
  if (sym.has('spot') && !direction) {
    const iss = speciesIssueFor('spot');
    const rainy = space && space.rain === '会淋雨';
    direction = {
      title: iss ? iss.title : '叶斑类问题：先降湿、清病叶',
      text: (iss ? iss.likely : '叶斑多发生在叶面反复沾水、通风差的情况。')
        + (rainy ? `你的「${space.name}」登记为会淋雨的位置——雨后叶面残留水分会给这类问题开路。` : ''),
    };
    if (iss) {
      A.push(...iss.actions.slice(0, 3));
    } else {
      A.push(...(rainy
        ? ['摘除明显病叶；预报有雨时考虑把能挪的挪到避雨处或搭挡雨', '闷天加强通风', '扩散明显再考虑按标签用药——本应用不提供剂量']
        : ['摘除明显病叶', '浇水浇根部而非喷叶面', '观察两天是否扩散']));
    }
    if (iss) usedSpeciesIssue = true;
    foldedLike = '斑点原因很多（真菌、细菌、晒伤、肥伤）；区分点：真菌斑常有轮纹/点点、晒伤多在上表面靠窗一侧、肥伤焦边。';
    foldedAlt = '不确诊任何具体病。若范围快速扩大到半片以上叶片，拍照后咨询更稳妥。';
  }

  /* —— 掉叶/掉苞 —— */
  if (sym.has('drop') && !direction) {
    if (answers.move === 'yes') {
      direction = {
        title: '环境突变是首要怀疑',
        text: '刚挪动过的植物掉苞、掉叶非常常见——它需要一个稳定期，不一定是养护做错了。',
      };
      A.push('先固定位置不折腾，水照见干见湿给，观察一到两周');
      foldedAlt = k && k.key === 'zhizi' ? '栀子花苞期对变动尤其敏感。' : '';
    } else {
      const iss = speciesIssueFor('drop');
      direction = { title: iss ? iss.title : '脱落类问题', text: iss ? iss.likely : '掉落多与水、温度骤变、成熟代谢有关：先回想最近 5 天水给得合不合适。' };
      if (iss) { A.push(...iss.actions.slice(0, 3)); usedSpeciesIssue = true; }
      else A.push('左手边摸土干不干，右手看全株：只是零星老叶=正常代谢，不必管');
    }
  }

  /* —— 黄叶 —— */
  if (sym.has('yellow-leaf') && !direction) {
    const iss = speciesIssueFor('yellow-leaf');
    if (iss) {
      direction = { title: iss.title, text: iss.likely };
      A.push(...iss.actions.slice(0, 3));
      usedSpeciesIssue = true;
      foldedAlt = '同时留意浇水：忽干忽涝也会让叶子整体变黄。';
    } else {
      direction = {
        title: '叶子发黄的常见三条路',
        text: '①老叶自然代谢（零星几片，正常）；②过湿伤根（黄且软暗）；③缺少光照（黄且茎细长）。看到哪一种描述接近，先朝那一个方向调整。',
      };
      A.push('摸土校准：土发湿→停浇；土正常→看光照');
      foldedAlt = '身份待确认的植物先别下重手，按"少动"原则观察。';
    }
  }

  /* —— 长势变差 —— */
  if (sym.has('weak') && !direction) {
    direction = {
      title: '长势变差：先看光照和盆',
      text: `长得慢、瘦弱多对应光照不够、盆子太小或肥不足${space ? `——「${space.name}」的环境信息${space.light ? '显示"' + space.light + '"' : '还没登记（不猜）'}` : ''}。`,
    };
    A.push(k && k.light ? `对照它的光照需求：${k.light}` : '尽量给更亮的位置（不暴晒），观察两周新叶');
    A.push(space && !space.light ? `到「摆放位置」给「${space.name}」补一条光照信息，判断会更准（名字本身不作数）` : '');
    if (answers.move === 'yes') foldedLike = '最近有环境变动：先给两周稳定期再下结论。';
    foldedAlt = '薄肥按标签补可以，但会先缺光就施肥没援助——先补光。';
  }
  A = A.filter(a => a && a.length); // 过滤空动作：宁可少给，不凑条数

  /* —— 叶尖焦干 —— */
  if (sym.has('brown-tip') && !direction) {
    const iss = speciesIssueFor('brown-tip');
    direction = { title: iss ? iss.title : '叶尖焦干常见原因', text: iss ? iss.likely : '空气干燥、肥偏浓、水质偏碱都是常见解释——温和问题，可以先调环境。' };
    if (iss) { A.push(...iss.actions.slice(0, 3)); usedSpeciesIssue = true; }
    else A.push('多喷水增湿；薄肥宁淡勿浓', '别放在暖气/空调风直吹处');
    foldedAlt = '新叶后就恢复正常；持续多片焦尖→查水质或肥';
  }

  /* —— 说不清/其他 ——（v4 §6.E：不看内容不再固定回"太笼统"；
     有具体线索就顺着查；确实模糊只补问最有用的一件事） */
  if (sym.has('other') && !direction) {
    let fa = null;
    if (freeText) {
      if (/虫|蚜|蚧|介壳|红蜘蛛|小飞虫|白粉虱/.test(freeText)) fa = { title: '先按"虫"方向看', text: '顺着你的描述先查虫：把叶背翻过来凑近看最有效。真有小虫先把这盆跟别的分开；看得见的虫用棉签蘸少量稀释洗洁精水就能擦掉，用药以产品标签为准、这里不给剂量。' };
      else if (/蔫|下垂|垂下来|耷拉|发软/.test(freeText)) fa = { title: '先按"蔫软"方向看', text: '顺着你的描述先看水分：手指插土两厘米——偏干就浇透；土还是湿的却蔫，多半是根先撑不住，先停水多通风（蔫不等于缺水）。' };
      else if (/黄|枯|焦|尖/.test(freeText)) fa = { title: '先按"叶色变化"方向看', text: '顺着你的描述先分新叶老叶：只是底部一两片老叶慢慢黄，是正常代谢；新叶也大片黄或带焦尖，多半是光照/浇水的问题——先别施肥。' };
      else if (/斑|点|锈|霉/.test(freeText)) fa = { title: '先按"斑点"方向看', text: '顺着你的描述先分干斑湿斑：干斑常见于空气太干或晒伤；湿斑带霉味多为病害——先别往叶面喷水，给病叶单独拍张照留档。' };
      else if (/掉|落|谢|倒/.test(freeText)) fa = { title: '先按"脱落"方向看', text: '顺着你的描述：老叶偶掉一两片、单朵花谢都正常；成片掉叶掉苞多与挪动、温差大、浇水突变有关——想想这几天动过什么。' };
      else if (/根|盆底|发臭|烂/.test(freeText)) fa = { title: '先按"根和盆"方向看', text: '顺着你的描述先查盆底孔：托盘积水立刻倒掉；怀疑根有问题，等土干后小心脱盆看看——白根硬挺就原样种回，发黑发软才需要处理。' };
    }
    direction = {
      title: fa ? fa.title : '还没法给出方向——只补问最有用的一件事',
      text: fa
        ? fa.text + '以上是顺着你的描述先排查的方向，不是确诊。'
        : ((freeText && freeText.length >= 4)
          ? `从「${freeText}」还听不出明确方向。最有用的一件事：凑近看一眼，说清"位置（叶/茎/盆/根）+ 什么颜色"，就能归到上面的具体现象排查。`
          : '不编造方向。就从三个词开始："哪里（叶/茎/盆/根）+ 什么颜色 + 大概几处"——说清这三个，我就能顺着查。')
          + ' 在看清之前，不动护理节奏、不施肥，是最安全的。',
    };
    A.push(...generalObservationActions(k));
  }

  if (!A.length) A.push(...generalObservationActions(k));

  return {
    needsInput: false,
    direction,
    actions: A.slice(0, 3),
    avoid,
    escalation,
    folded: { likely: foldedLike, alternative: foldedAlt },
    basis: basisBits.join(' + '),
    usedSpeciesIssue,
  };
}
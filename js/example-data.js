// ============================================================
// example-data.js — 示例数据（v3 单家庭 · 固定 ID 版，可一键清除）
//
// 用途（v3）：
//   · 首次使用快速理解应用能力；演示与截图（?demo=1）直接复用固定 ID
//     （如 #/plant/ex-yueji、#/health/ex-yueji?sym=wilt&soil=wet&go=1）；
//   · 场景对齐验收：两个同名「阳台」属性不同（T08）、「走廊」仅名称
//     光照未登记（T07：名称不代表环境）、多肉个体差异"里侧晒不到"（T10）、
//     白掌暖气备注（背景联动建议）、旧花苞档案照不作当前状态（T12）；
//   · 全部内容标注 isExample；设置页可一键清除，不影响真实数据；
//   · 示例家不是"你的家"：用户建档第一盆真实植物时自动另建（ensureHome）。
// ============================================================

import * as store from './store.js';

const DAY = 86400000;

/** 示例封面（SVG 占位，非照片；图内明示"示例数据"） */
function cover(label, from, to) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="240" height="240" fill="url(#g)"/>
    <circle cx="120" cy="104" r="52" fill="rgba(255,255,255,.88)"/>
    <path d="M120 60 C86 66 76 118 120 150 C164 118 154 66 120 60Z" fill="#2d6a4f"/>
    <path d="M120 150 C148 128 162 96 120 60" stroke="#1f4d39" stroke-width="4" fill="none"/>
    <text x="120" y="196" font-size="30" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${label}</text>
    <text x="120" y="226" font-size="16" text-anchor="middle" fill="rgba(255,255,255,.85)" font-family="sans-serif">示例数据 · 可清除</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

export async function installExampleData() {
  if (store.listFamilies().some(f => f.isExample)) {
    return { ok: false, msg: '示例已在应用中。需要重新载入的话，可先到设置页清除示例。' };
  }

  /* 一个示例家（杭州 · 江南） */
  const home = store.addFamily({
    id: 'ex-home', name: '示例之家',
    city: { name: '杭州', province: '浙江', zone: '江南' }, isExample: true,
  });
  if (!home) {
    // v4：本机存储写不进时，示例装载中止但不拖垮应用（保存失败已有全局提示，不静默）
    return { ok: false, msg: '本机存储空间不足——示例没装上，不影响正常建档；清理后可再试。' };
  }

  /* 位置：两个同名「阳台」但属性不同（T08 演示） */
  const lt = store.addSpace({ id: 'ex-space-lt', homeId: home.id, name: '阳台', exposure: '半室外', rain: '会淋雨', light: '有直射光', note: '露天朝南，下雨会淋到' });
  const fb = store.addSpace({ id: 'ex-space-fb', homeId: home.id, name: '阳台', exposure: '室内', rain: '基本不淋雨', light: '靠窗', note: '封闭窗台，冬天基本不开窗' });
  const zl = store.addSpace({ id: 'ex-space-zl', homeId: home.id, name: '走廊', exposure: '室内', light: '' });   // 仅名称：光照未知（T07）
  const ck = store.addSpace({ id: 'ex-space-ck', homeId: home.id, name: '客厅窗边', exposure: '室内', light: '靠窗' });

  /* 六盆示例植物（挂在位置上，一次建位置多盆复用——T06） */
  const yueji = store.addPlant({ id: 'ex-yueji', familyId: home.id, spaceId: lt.id, name: '阳台月季', nickname: '妈妈的花', knowledgeKey: 'yueji', identity: { cnName: '月季', sciName: 'Rosa hybrida', source: 'knowledge' }, isExample: true });
  const duorou = store.addPlant({ id: 'ex-duorou', familyId: home.id, spaceId: fb.id, name: '多肉 · 胧月', nickname: '胖胧月', knowledgeKey: 'duorou', identity: { cnName: '胧月', sciName: 'Graptopetalum paraguayense', source: 'knowledge' }, micro: '放在里侧，基本晒不到', isExample: true });
  const moli = store.addPlant({ id: 'ex-moli', familyId: home.id, spaceId: zl.id, name: '茉莉', knowledgeKey: 'moli', identity: { cnName: '茉莉', sciName: 'Jasminum sambac', source: 'knowledge' }, isExample: true });
  const baizhang = store.addPlant({ id: 'ex-baizhang', familyId: home.id, spaceId: ck.id, name: '白掌', knowledgeKey: 'baizhang', identity: { cnName: '白掌', sciName: 'Spathiphyllum', source: 'knowledge' }, isExample: true });
  const hudielan = store.addPlant({ id: 'ex-hudielan', familyId: home.id, spaceId: ck.id, name: '蝴蝶兰', knowledgeKey: 'hudielan', identity: { cnName: '蝴蝶兰', sciName: 'Phalaenopsis', source: 'knowledge' }, isExample: true });
  const lvluo = store.addPlant({ id: 'ex-lvluo', familyId: home.id, spaceId: ck.id, name: '绿萝', knowledgeKey: 'lvluo', identity: { cnName: '绿萝', sciName: 'Epipremnum aureum', source: 'knowledge' }, isExample: true });

  /* 观察（变化记录，非流水） */
  store.addObservation({ plantId: yueji.id, tags: ['spot'], text: '叶子上有几个黑点，下面两片黄了', source: 'user', stateAt: Date.now() - 5 * DAY });
  store.addObservation({ plantId: baizhang.id, tags: ['wilt'], text: '下午叶子有点垂，也许是该浇水了', source: 'user', uncertain: true, stateAt: Date.now() - 1 * DAY });
  store.addObservation({ plantId: hudielan.id, tags: ['new-shoot'], text: '根上好像冒了个新芽（待确认）', source: 'user', uncertain: true, stateAt: Date.now() - 2 * DAY });
  store.addObservation({ plantId: duorou.id, tags: ['bud'], text: '（旧档案照里的样子，不知现在如何）', source: 'photo', uncertain: true, isCurrentState: false, stateAt: Date.now() - 60 * DAY });

  /* 长期背景备注 */
  store.addNote(baizhang.id, '冬天客厅会开暖气，电视柜旁挺暖和。', 'heating');

  /* 封面照片（SVG 占位、固定 ID；异步保存） */
  const covers = [
    [yueji, '月季', '#d68f8a', '#a5514d'],
    [duorou, '多肉', '#d6a9b1', '#a5717f'],
    [moli, '茉莉', '#cbd6a0', '#8a9a5c'],
    [baizhang, '白掌', '#a9c2b2', '#6f8f7c'],
    [hudielan, '蝴蝶兰', '#9db8d6', '#5b7aa6'],
    [lvluo, '绿萝', '#7fb69b', '#3d7a5c'],
  ];
  for (const [p, label, from, to] of covers) {
    const ph = await store.savePhoto(cover(label, from, to), { forceId: 'ex-photo-' + p.id.replace('ex-', '') });
    p.photoIds.push(ph.id);
  }

  store.save();
  return {
    ok: true,
    msg: '示例已载入：示例之家（杭州）——两个同名「阳台」演示"属性不同、建议就不同"。可随时在设置页一键清除。',
  };
}

export function hasExampleData() {
  return store.listFamilies().some(f => f.isExample);
}
// ============================================================
// knowledge.js — 知识库聚合入口
//
// 数据拆分在三个文件以避免单文件过大：
//   city-db.js  气候分区 + 省市表（定位城市候选、季节标签）
//   plants-a/b/c.js  13 种常见家庭植物养护知识
//
// 口径（与需求红线一致）：
//   参考间隔仅为粗略范围，必须配合现场判断，不自动执行；
//   肥料与药剂一律以产品标签为准，本库不提供浓度；
//   阶段提示为"季节推测"，与照片/用户观察明确区分。
// ============================================================

import { ZONES, REGIONS, nearestCities, findCity, seasonOf, zoneDesc } from './city-db.js';
import { PLANTS_A } from './plants-a.js';
import { PLANTS_B } from './plants-b.js';
import { PLANTS_C } from './plants-c.js';

export const PLANTS = [...PLANTS_A, ...PLANTS_B, ...PLANTS_C];

export { ZONES, REGIONS, nearestCities, findCity, seasonOf, zoneDesc };

/** key → 知识条目 */
export function findKnowledge(key) {
  return PLANTS.find(p => p.key === key) || null;
}

/** 按名称/别名/拼音键搜索（建档身份选择用） */
export function searchKnowledge(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return PLANTS;
  return PLANTS.filter(p =>
    p.name.toLowerCase().includes(s) ||
    p.aliases.some(a => a.toLowerCase().includes(s)) ||
    p.key.includes(s)
  );
}

/** 五行小卡素材取档：返回 [常规, 精简]；引擎按行长选档 */
export function cardPick(pair) {
  return Array.isArray(pair) ? pair : ['', ''];
}
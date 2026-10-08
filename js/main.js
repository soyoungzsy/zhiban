// ============================================================
// main.js — 入口（v3）
//
// 启动序列（一次性、幂等，全部带兜底不阻塞主流程）：
//   initDB（IndexedDB；不可用时照片自动内联降级）
//   → migratePhotosToIDBOnce（v2 内联照片迁 IDB；先备份后迁移）
//   → migrateLegacyPositions（旧"位置文字"→ 共享位置档案，同名文本才合并）
//   → ?demo=1 且无示例时装入示例（截图/演示直达，如 #/plant/ex-yueji）
//   → render
//
// 会话级：
//   __zhibanSaveFailHook —— 本机存储写入失败 → 全局可见 toast（4 秒节流）
//
// 路由（v3 单家庭）：
//   标签页：首页 / 建档 / 设置（三项；旧"家庭"标签取消）
//   覆盖页：档案(#/plant) / 哪里不对(#/health) / 说一说(#/say) / 摆放位置(#/spaces)
//   兼容：#/family 一律重定向到 #/spaces（那里含"选我的家"迁移面板）
// ============================================================

import { $, $$, toast } from './ui.js';
import { initDB } from './db.js';
import * as store from './store.js';
import * as HM from './home-model.js';
import { installExampleData } from './example-data.js';
import { render as renderHome } from './views/home.js';
import { render as renderAdd } from './views/add.js';
import { render as renderSettings } from './views/settings.js';
import { render as renderPlant } from './views/plant.js';
import { render as renderHealth } from './views/health.js';
import { render as renderSay } from './views/say.js';
import { render as renderSpaces } from './views/spaces.js';
import { render as renderBatch } from './views/batch.js';
import { initPwa } from './pwa.js';
initPwa();   // 主屏幕/离线外壳/版本横幅——不依赖 DOM ready，自带环境守卫.

const TAB_VIEWS = { home: renderHome, add: renderAdd, settings: renderSettings };
const SUB_VIEWS = { plant: renderPlant, health: renderHealth, say: renderSay, spaces: renderSpaces, batch: renderBatch };

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...args] = h.split('/');
  return { name: name || 'home', args };
}

function render() {
  // v3 单家庭：旧"家庭"链接全部导向"摆放位置"（含选家迁移面板与城市设置）
  const parsed = parseHash();
  if (parsed.name === 'family') { location.replace('#/spaces'); return; }

  const { name, args } = parsed;
  const tabbar = $('#tabbar');
  const stack = $('#stack-root');
  const view = $('#view');

  if (TAB_VIEWS[name]) {
    stack.innerHTML = '';
    tabbar.classList.remove('hide');
    $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
    TAB_VIEWS[name](view, args);
    window.scrollTo(0, 0);
  } else if (SUB_VIEWS[name]) {
    tabbar.classList.add('hide');
    stack.innerHTML = '';
    const sp = document.createElement('div');
    sp.className = 'subpage';
    stack.appendChild(sp);
    SUB_VIEWS[name](sp, args);
    sp.scrollTop = 0;
  } else {
    location.hash = '#/home'; // 未知路由回首页
  }
}

/* 本机存储写入失败 → 全局可见（不静默丢数据），4 秒节流防连击 */
globalThis.__zhibanSaveFailHook = (() => {
  let lastFailToast = 0;
  return () => {
    const now = Date.now();
    if (now - lastFailToast < 4000) return;
    lastFailToast = now;
    try {
      toast('没能保存：本机存储空间可能已满。可到设置里导出备份，并清理不用的植物或照片。');
    } catch (e) { /* 无 UI 环境忽略 */ }
  };
})();

async function boot() {
  try { await initDB(); } catch (e) { console.warn('initDB 跳过：', e); }
  try { await store.migratePhotosToIDBOnce(); } catch (e) { console.warn('照片迁移跳过：', e); }
  try { const r = HM.migrateLegacyPositions(); if (r && r.linked) console.log('旧位置已迁移为共享位置档案', r); } catch (e) { console.warn('位置迁移跳过：', e); }
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === '1') {
      const r = await installExampleData();  // 幂等：已有示例时返回 ok:false，静默忽略
    }
  } catch (e) { console.warn('demo 示例未装入（可能已存在）：', e); }
  render();
}

/* DOM 环境守卫：浏览器注册事件；Node（模块语法验证）安全跳过 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('hashchange', render);
  let booted = false;
  const start = () => { if (!booted) { booted = true; boot(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
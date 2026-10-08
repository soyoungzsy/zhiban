// ============================================================
// views/home.js — 首页（单家庭版，v3 §5/§7.3）
//
//   1) 日期问候 + 天气未接入标注 + （多家庭时）迁移警示 + 示例横幅
//   2) 【本周照顾重点】top3 可展开；分类与证据标签同前；不凑数
//   3) 【我的植物】当前位置筛选（全部/各位置/暂未设置）+ 名称查找；
//      卡片带照片（异步水合）、昵称、位置、一条提示
//   4) 空状态：可直接建档（不先建家/位置，v3 T01）
// ============================================================

import * as store from '../store.js';
import * as engine from '../engine.js';
import { $, $$, esc, toast } from '../ui.js';
import * as HM from '../home-model.js';
import { installExampleData, hasExampleData } from '../example-data.js';
import { speakSupported, speakText, stopSpeak } from '../services.js';

let weekShowAll = false;

/* ---------------- 本周照顾重点 ---------------- */

function weekItemHTML(it) {
  const cat = engine.CATEGORY_LABEL[it.category] || it.category;
  const ev = engine.EVIDENCE_LABEL[it.evidence] || it.evidence;
  const sp = it.plant.spaceId ? store.getSpace(it.plant.spaceId) : null;
  const subTxt = [sp ? sp.name : '', it.family && it.family.city ? it.family.city.name : ''].filter(Boolean).join(' · ');
  const timeTxt = it.stateAt
    ? ` · ${engine.relDay(it.stateAt)}${it.uncertain ? '（待你核实）' : ''}`
    : (it.ctx ? ` · ${it.ctx.city}当前季节` : '');
  return `
    <div class="week-item" data-plant="${it.plant.id}">
      <div class="wi-main">
        <div class="wi-meta">
          <span class="cat-tag cat-${it.category}">${cat}</span>
          <span><b>${esc(it.plant.nickname || it.plant.name)}</b>
            <span class="sub">${subTxt ? '· ' + esc(subTxt) : ''}</span>
          </span>
          <span class="ev-tag ev-${it.evidence}">${ev}${timeTxt}</span>
        </div>
        <div class="wi-title">${esc(it.title)}</div>
        <div class="wi-cond">${esc(it.cond)}</div>
        ${it.actions ? `<details class="fold"><summary>具体先做什么</summary><div class="fold-body">${it.actions.map(a => `- ${esc(a)}`).join('<br>')}</div></details>` : ''}
      </div>
    </div>`;
}

function renderWeekly(root) {
  const box = $('#week-box', root);
  const items = engine.weeklyItems();
  const show = weekShowAll ? items : items.slice(0, 3);

  let html = '';
  if (!items.length) {
    html = `<div class="week-empty">本周暂无新的特别提醒。<br>
      照常按各植物档案里的「平时怎么养」判断即可，不需要因为打开应用而加浇或加肥。</div>`;
  } else {
    html = show.map(weekItemHTML).join('');
    if (items.length > 3) {
      html += `<button class="btn btn-ghost btn-s" id="week-toggle" style="width:100%">
        ${weekShowAll ? '收起' : `展开全部（${items.length} 条）`}</button>`;
    }
  }
  box.innerHTML = html;

  const t = $('#week-toggle', root);
  if (t) t.addEventListener('click', () => { weekShowAll = !weekShowAll; renderWeekly(root); });

  // 点条目进入档案
  $$('.week-item', box).forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', e => {
      if (e.target.closest('details')) return;
      location.hash = `#/plant/${el.dataset.plant}`;
    });
  });

  const s = $('#week-listen', root);
  if (s) s.addEventListener('click', () => {
    const text = items.slice(0, 3).map(it =>
      `${it.plant.nickname || it.plant.name}，${it.title}。${it.cond}`).join('。');
    if (!speakSupported()) return;
    s.dataset.on === '1' ? (stopSpeak(), s.dataset.on = '0', s.textContent = '听一听重点') 
      : (speakText(text, () => { s.dataset.on = '0'; s.textContent = '听一听重点'; }), s.dataset.on = '1', s.textContent = '停止朗读');
  });
}

/* ---------------- 我的植物 ---------------- */

/* ---------------- 我的植物（单家庭 + 位置筛选） ---------------- */

function plantTileHTML(p) {
  const space = p.spaceId ? store.getSpace(p.spaceId) : null;
  const posName = space ? space.name : (p.env.position || '位置未设置');
  const pid = p.photoIds[0] || null;
  const tip = engine.plantTileTip(p);
  return `
    <div class="plant-tile card" data-plant="${p.id}" style="cursor:pointer">
      <div class="thumb">${pid ? `<img data-ph="${pid}" alt="${esc(p.nickname || p.name)}">` : `<div class="thumb-ph">植</div>`}</div>
      <div class="pt-body">
        <div class="pt-name">${esc(p.nickname || p.name)}
          ${p.isExample ? '<span class="badge-pending">示例</span>' : ''}
          ${p.identityPending ? '<span class="badge-pending">待确认</span>' : ''}
        </div>
        <div class="family-dot"><i style="background:var(--c-primary)"></i>${esc(posName)}</div>
        <div class="pt-tip">${esc(tip)}</div>
      </div>
    </div>`;
}

/** 照片异步水合：先渲染占位（data-ph），再批量把真实数据填入（v3 7.4 存储分层） */
async function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-ph]')) {
    try {
      const ph = await store.getPhoto(img.dataset.ph);
      if (ph && ph.dataUrl) img.src = ph.dataUrl;
    } catch (e) { /* 单张失败不阻塞整页 */ }
  }
}

function renderPlantList(root, home, query = '') {
  const box = $('#plant-list', root);
  const filter = store.getPref('activeSpaceFilter', 'all');
  const q = query.trim().toLowerCase();

  let plants = home ? store.listPlants().filter(p => p.familyId === home.id) : [];
  if (filter === 'none') plants = plants.filter(p => !p.spaceId);
  else if (filter !== 'all') plants = plants.filter(p => p.spaceId === filter);
  if (q) plants = plants.filter(p =>
    (p.nickname || '').toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    (p.spaceId ? ((store.getSpace(p.spaceId) || {}).name || '') : '').toLowerCase().includes(q) ||
    (p.env.position || '').toLowerCase().includes(q)
  );

  if (!plants.length) {
    box.innerHTML = `<div class="empty"><div class="e-icon">植</div>
      ${(q || filter !== 'all') ? '没找到匹配的植物；换个名称或位置试试。' : '这里还没有植物档案。<br>点下面的「建档」拍第一盆吧。'}</div>`;
    return;
  }
  box.innerHTML = plants.map(p => plantTileHTML(p)).join('');
  $$('.plant-tile', box).forEach(el =>
    el.addEventListener('click', () => { location.hash = `#/plant/${el.dataset.plant}`; }));
  hydratePhotos(box);
}

/* ---------------- 主体 ---------------- */

export function render(root) {
  weekShowAll = false;
  const home = HM.currentHome();
  if (home && home.city && home.city.qw) weather.refreshQuiet(home);   // v4 §5：火忘式刷新缓存
  const needsPick = HM.needsHomePick();
  const plants = home ? store.listPlants().filter(p => p.familyId === home.id) : [];
  const spaces = home ? store.listSpaces(home.id) : [];

  const head = `
    <div class="row-between" style="align-items:flex-end">
      <div>
        <div class="h-page">植伴</div>
        <div class="sub">${engine.fmtToday()} · 打开就知道先看哪盆</div>
      </div>
      ${speakSupported() ? '<button class="listen-btn" id="week-listen">听一听重点</button>' : ''}
    </div>
    ${plants.length && home ? `<div class="note note-plain mt8">
      <span class="badge-offline">天气实况未接入</span>
      建议按${home.city ? '「' + esc(home.city.name) + '」所在地区（' + esc(home.city.zone) + '）' : '你所在地区'}的当前季节通用生成，标注"季节推测"，不代表实时天气。</div>` : ''}
    ${needsPick ? `<div class="note note-warn mt8">检测到多个家庭——植伴现在按<b>一个家</b>工作。
      <a href="#/spaces" style="font-weight:700;color:var(--c-warn)">去选择我的家 →</a>
      <div class="tiny mt8">其余家庭原样归档保留（不删除任何数据），可在设置页导出找回。</div></div>` : ''}
    ${home && home.isExample ? `<div class="note mt8">当前展示的是<b>示例家庭</b>——它不会变成你的家；建档第一盆植物时自动建立。</div>` : ''}
  `;

  /* 空状态（v3 T01）：不建家、不建位置也能直接建档 */
  if (!plants.length && !needsPick) {
    root.innerHTML = head + `
      <div class="empty">
        <div class="e-icon">植</div>
        <b>从拍一盆植物开始</b>
        <div class="mt8">不用先建家、不用选位置：名字和位置都可以之后补，<br>保存第一盆时会自动建立「我的家」。</div>
        <div class="gap-btns" style="max-width:320px;margin:22px auto 0">
          <a class="btn btn-primary" href="#/add">拍照建档</a>
          ${!hasExampleData() ? `<button class="btn btn-outline" id="btn-demo">先看看示例</button>` : ''}
        </div>
        <div class="tiny mt8">（示例内容全部标注「示例」，设置页可一键清除）</div>
      </div>`;
    const b = $('#btn-demo', root);
    if (b) b.addEventListener('click', async () => {
      const { installExampleData } = await import('../example-data.js');
      const r = await installExampleData();
      toast((r && r.msg) || '示例已载入');
      render(root);
    });
    return;
  }

  if (!home) { root.innerHTML = head; return; }  // 仅"多家庭待选"场景：顶部迁移卡引导

  const filter = store.getPref('activeSpaceFilter', 'all');
  root.innerHTML = head + `
    <div class="section-h"><h2>本周照顾重点</h2><span class="tiny">指引非任务 · 无需打卡</span></div>
    <div class="card" id="week-box"></div>

    <div class="section-h"><h2>我的植物</h2>
      <span class="row">
        <a class="minor-link" href="#/spaces">位置</a>
        <a class="minor-link" href="#/add" style="margin-left:10px">＋ 建档</a>
      </span></div>
    ${(spaces.length || filter !== 'all') && plants.length ? `
    <div class="chip-row" id="space-filter">
      <span class="chip ${filter === 'all' ? 'on' : ''}" data-s="all">全部（${plants.length}）</span>
      ${spaces.map(sp => `<span class="chip ${filter === sp.id ? 'on' : ''}" data-s="${sp.id}">${esc(sp.name)}（${store.spacePlantCount(sp.id)}）</span>`).join('')}
      ${plants.some(p => !p.spaceId) ? `<span class="chip ${filter === 'none' ? 'on' : ''}" data-s="none">暂未设置</span>` : ''}
    </div>` : ''}
    <div class="search-bar">
      <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/></svg>
      <input class="input" id="plant-search" placeholder="按名称或位置查找（如：窗边的绿萝）">
    </div>
    <div id="plant-list"></div>
  `;

  /* 位置筛选（v3 §2：按阳台、走廊、客厅窗边筛选） */
  $$('#space-filter .chip', root).forEach(c => c.addEventListener('click', () => {
    store.setPref('activeSpaceFilter', c.dataset.s);
    render(root);
  }));

  const search = $('#plant-search', root);
  if (search) search.addEventListener('input', () => renderPlantList(root, home, search.value));

  renderWeekly(root);
  renderPlantList(root, home, '');
}

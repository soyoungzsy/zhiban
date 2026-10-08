// ============================================================
// views/plant.js — 植物档案页
//
// 顺序（v3）：1) 这盆是谁（含位置）  2) 现在怎么照顾（1—3条+听一听）
// 3) 位置小结（positionAssess：合适直说；最小改善；替代候选不虚构，T22/T09）
// 4) 平时怎么养  5) 五行小卡（大字/复制/存图）  6) 更多资料（折叠）
// 主操作：哪里不对 / 说一说 / 养护小卡；编辑与删除放资料区（单家庭：无转移入口）。
// 红线：不提供「我浇过了」、不显示倒计时、不推算"已几天没浇水"；蔫≠只缺水（S2）。
// ============================================================

import * as store from '../store.js';
import * as engine from '../engine.js';
import * as HM from '../home-model.js';
import { findKnowledge } from '../knowledge.js';
import { $, $$, esc, toast, confirmDlg, openSheet, openFullMask } from '../ui.js';
import { speakSupported, speakText, stopSpeak, copyText, cardImage, downloadDataUrl } from '../services.js';

/* ---------- 小图标 ---------- */
const I = {
  cam: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 4 7.8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.8L15 4H9zm3 4.6A4.4 4.4 0 1 1 12 17.4 4.4 4.4 0 0 1 12 8.6zm0 2a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm-7 9a7 7 0 0 0 14 0h-2a5 5 0 0 1-10 0H5zm6 7v2h3v-2h-3z"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 3v2h10V6H7zm0 5v2h10v-2H7zm0 5v2h6v-2H7z"/></svg>',
};

/* ---------- 小卡（大字 / 复制 / 保存图片） ---------- */

function showCardBig(card, plantName) {
  const { root, close } = openFullMask(`
    <div class="card-paper">
      ${card.lines.map(l => `<div class="cp-row">${esc(l)}</div>`).join('')}
    </div>
    <div class="row" style="justify-content:center">
      <button class="btn btn-s" id="cp-copy">复制文字</button>
      <button class="btn btn-primary btn-s" id="cp-save">保存图片</button>
      <button class="btn btn-s" id="cp-close">关闭</button>
    </div>
    <div style="color:#fff;font-size:.8rem;text-align:center">黑白图片打印/手抄都清楚；iOS 保存失败时可在生成的图片上长按存图</div>
  `);
  $('#cp-close', root).addEventListener('click', close);
  $('#cp-copy', root).addEventListener('click', async () => {
    toast(await copyText(card.lines.join('\n')) ? '已复制 5 行，可直接手抄' : '复制失败，可长按图片存图后查看');
  });
  $('#cp-save', root).addEventListener('click', () => {
    try {
      const img = cardImage(card.lines);
      downloadDataUrl(img.dataUrl, `${plantName}-养护小卡.png`);
      toast('图片已生成并开始下载');
      const big = document.createElement('img');
      big.src = img.dataUrl;
      big.style.cssText = 'max-width:82vw;max-height:56vh;border-radius:10px;box-shadow:0 6px 30px rgba(0,0,0,.4)';
      root.insertBefore(big, root.firstChild);
    } catch (e) { toast('生成图片失败：' + (e.message || e)); }
  });
}

/* ---------- 位置小结（v3 §4.5） ---------- */

function positionCardHTML(pa, space, plant) {
  if (!pa) return '';
  const cls = pa.verdict === 'fit' ? 'note'
    : (pa.verdict === 'mismatch' || pa.verdict === 'improve') ? 'note note-warn'
    : 'note note-plain';
  const link = pa.verdict === 'no-space'
    ? ` <a class="minor-link" href="#/spaces" style="font-weight:700;color:var(--c-warn)">去选位置 →</a>`
    : pa.verdict === 'unknown'
      ? ` <a class="minor-link" href="#/spaces" style="font-weight:700">去补充位置光照信息 →</a>`
      : '';
  const notes = (pa.notes || []).length ? `<div class="tiny mt8">${pa.notes.map(esc).join('；')}</div>` : '';
  const micro = plant.env.micro
    ? `<div class="tiny mt8">这一盆的个体差异：${esc(plant.env.micro)}（只影响这一盆，不改共享位置）</div>` : '';
  return `
  <div style="margin-bottom:14px">
    <div class="${cls}"><b>${esc(pa.title)}</b><br>${esc(pa.text)}${link}${notes}${micro}</div>
  </div>`;
}

/* ---------- 编辑基本信息 ---------- */

function editSheet(plant, rerender) {
  const home = HM.currentHome();
  const spaces = home && !home.isExample ? store.listSpaces(home.id) : [];
  let spaceId = plant.spaceId || 'none';
  const sheet = openSheet(`
    <h3>编辑基本信息</h3>
    <div class="field"><label>常用名称</label><input class="input" id="e-name" value="${esc(plant.name)}"></div>
    <div class="field"><label>昵称（可选，如「妈妈的花」）</label><input class="input" id="e-nick" value="${esc(plant.nickname || '')}" placeholder="不填就显示常用名称"></div>
    <div class="field"><label>摆放位置（从已有位置里选；新建去「摆放位置」页）</label>
      <div class="chip-row" id="e-spaces">
        <span class="chip ${spaceId === 'none' ? 'on' : ''}" data-sp="none">暂未设置</span>
        ${spaces.map(sp => `<span class="chip ${spaceId === sp.id ? 'on' : ''}" data-sp="${sp.id}">${esc(sp.name)}</span>`).join('')}
      </div></div>
    <div class="field"><label>个体差异（可选，只影响这一盆）</label>
      <input class="input" id="e-micro" value="${esc(plant.env.micro || '')}" placeholder="如：放在阳台里侧，基本晒不到"></div>
    <button class="btn btn-primary btn-block" id="e-save">保存</button>
  `);
  $$('#e-spaces .chip', sheet.root).forEach(c => c.addEventListener('click', () => {
    spaceId = c.dataset.sp;
    $$('#e-spaces .chip', sheet.root).forEach(x => x.classList.toggle('on', x.dataset.sp === spaceId));
  }));
  $('#e-save', sheet.root).addEventListener('click', () => {
    const name = $('#e-name', sheet.root).value.trim();
    if (!name) return toast('名称不能为空');
    store.updatePlant(plant.id, {
      name,
      nickname: $('#e-nick', sheet.root).value.trim(),
      spaceId: spaceId === 'none' ? null : spaceId,
      env: { position: '', micro: $('#e-micro', sheet.root).value.trim(), tags: plant.env.tags },
    });
    sheet.close(); toast('已保存'); rerender();
  });
}

/* ---------- 删除 ---------- */

async function deletePlantFlow(plant) {
  const ok = await confirmDlg({
    title: '删除这盆植物？',
    danger: true,
    okText: '删除',
    body: `将永久删除「${esc(plant.nickname || plant.name)}」的档案、${plant.photoIds.length} 张照片与全部观察记录。<br><b>同一家庭的其他植物不受影响。</b>此操作不可撤销。`,
  });
  if (!ok) return;
  store.deletePlant(plant.id);
  toast('已删除');
  if (history.length > 1) history.back(); else location.hash = '#/home';
}

/* ---------- 主体 ---------- */

export function render(subChildren, args) {
  const plant = store.getPlant(args[0]);
  const box = subChildren;
  if (!plant) {
    box.innerHTML = `<div class="subpage-inner" style="padding-top:80px;text-align:center">
      <div class="empty">没有找到这盆植物（可能已被删除）。<br><a class="btn btn-primary mt14" href="#/home" style="display:inline-flex">回到首页</a></div></div>`;
    return;
  }
  renderPlant(box, plant);
}

function renderPlant(box, plant) {
  const fam = store.getFamily(plant.familyId);
  const k = findKnowledge(plant.knowledgeKey);
  const ctx = engine.seasonContext(fam);
  const space = plant.spaceId ? store.getSpace(plant.spaceId) : null;
  const posName = space ? space.name : (plant.env.position || '暂未设置');
  const pa = engine.positionAssess(plant, space, k, ctx);
  const rerender = () => renderPlant(box, store.getPlant(plant.id) || plant);

  const envTagsHTML = plant.env.tags.length
    ? plant.env.tags.map(t => `<span class="chip" style="min-height:32px">${esc(t.text)}${t.source === 'photo' ? '<span class="tiny">照片推测</span>' : ''}</span>`).join('')
    : '<span class="tiny">未记录环境（可拍照或用「说一说」补充）</span>';

  const notesHTML = plant.notes.length
    ? `<div class="sm"><span class="k">你告诉我</span><span class="v">${plant.notes.map(n => esc(n.text)).join('<br>')}</span></div>`
    : '';

  /* --- 现在怎么照顾 --- */
  let nowHTML;
  if (plant.identityPending || !k) {
    nowHTML = `<div class="note note-warn">这盆的身份还没确认（暂按「待确认植物」处理）。
      帮它确认一下：点下面的「说一说」告诉我名字，或直接从常见植物里找；确认后会有针对性建议和五行小卡。</div>`;
  } else {
    const tips = engine.plantNowTips(plant.id);
    nowHTML = tips.length ? tips.map(t => `
      <div class="week-item" style="cursor:default">
        <div class="wi-main">
          <div class="wi-meta">
            <span class="cat-tag cat-${t.category}">${engine.CATEGORY_LABEL[t.category]}</span>
            ${t.stateAt ? `<span class="ev-tag ev-${t.evidence}">${engine.EVIDENCE_LABEL[t.evidence]} · ${engine.relDay(t.stateAt)}</span>`
              : `<span class="ev-tag ev-${t.evidence}">${engine.EVIDENCE_LABEL[t.evidence]}${t.ctx ? ' · ' + esc(t.ctx.city) + '当前季节' : ''}</span>`}
          </div>
          <div class="wi-title">${esc(t.title)}</div>
          <div class="wi-cond">${esc(t.cond)}</div>
          ${t.actions ? `<details class="fold"><summary>具体先做什么</summary><div class="fold-body">${t.actions.map(a => '- ' + esc(a)).join('<br>')}</div></details>` : ''}
        </div>
      </div>`).join('')
      + (speakSupported() ? `<button class="listen-btn" id="tip-speak">听一听这些提醒</button>` : '')
      : `<div class="week-empty">现在没有需要特别处理的事项。<br>照常按下面「平时怎么养」判断即可&nbsp;——&nbsp;看情况照顾，不需要打卡。</div>`;
  }

  /* --- 平时怎么养 --- */
  const wg = engine.waterGuidance(plant, fam);
  const waterHTML = !wg ? `<div class="note">身份确认后可给出浇水参考。</div>` : `
    <div class="sm"><span class="k">原则</span><span class="v">${esc(wg.principle)}</span></div>
    ${wg.mode === 'hydro'
      ? `<div class="sm"><span class="k">怎么看</span><span class="v">${esc(wg.check)}</span></div>`
      : `<div class="sm"><span class="k">参考间隔</span><span class="v">${esc(wg.intervalText || '未设置城市，暂无法给出按季节的参考范围')}<br><span class="tiny">${esc(wg.intervalCondition)}</span></span></div>
         <div class="sm"><span class="k">现场判断</span><span class="v"><b>${esc(wg.check)}</b><br><span class="tiny">在花盆旁就能判断，判断结果不用录入应用</span></span></div>`}
    <div class="sm"><span class="k">怎么浇</span><span class="v">${esc(wg.how)}</span></div>
    ${wg.warn ? `<div class="sm"><span class="k">注意</span><span class="v">${esc(wg.warn)}</span></div>` : ''}
    ${wg.mode !== 'hydro' && wg.intervals ? `<details class="fold"><summary>四季参考范围</summary><div class="fold-body">${['春', '夏', '秋', '冬'].map(s => `${s}：约 ${wg.intervals[s][0]}—${wg.intervals[s][1]} 天一次`).join('　·　')}</div></details>` : ''}
    <div class="note note-plain mt8">以上是参考规律而不是日程——植物到底浇没浇、浇了多少，由你在现场判断，应用不记录。</div>`;

  const fertHTML = k ? `
    <div class="sm"><span class="k">施肥原则</span><span class="v">${esc(k.fert.principle)}</span></div>
    <div class="chip-row" style="margin-top:6px">${k.fert.limits.map(l => `<span class="chip" style="min-height:32px">${esc(l)}</span>`).join('')}</div>
    <div class="tiny mt8">用量以你手上肥料的标签为准。应用不知道你最近是否施过肥——施过就等下一轮，别因打开应用而重复施肥。</div>`
    : '<div class="note">身份确认后可给出施肥原则。</div>';

  const tabooHTML = k
    ? `<div class="chip-row">${k.taboo.map(t => `<span class="chip" style="min-height:32px;background:#f8e7dc;color:var(--c-warn);border-color:#e8c8ae">别：${esc(t)}</span>`).join('')}</div>`
    : '';

  /* --- 小卡 --- */
  const card = engine.makeCard(plant);
  const cardHTML = !card.ok
    ? `<div class="note note-warn">身份确认后可生成小卡。</div>`
    : `<div class="row-between" style="align-items:flex-start;gap:14px">
        <div class="card-paper-mini">${card.lines.map(l => `<div class="cp-row">${esc(l)}</div>`).join('')}</div>
        <div style="flex:1">
          <div class="tiny">已校验：共 5 行 · 每行 ≤10 字 · 名称在五行内</div>
          <div class="tiny">只放长期规则，方便手抄到纸片挂盆上</div>
          <div class="row mt8">
            <button class="btn btn-s" id="c-big">大字</button>
            <button class="btn btn-s" id="c-copy">复制</button>
            <button class="btn btn-primary btn-s" id="c-save">存图</button>
          </div>
        </div>
      </div>${card.warnings?.length ? `<div class="tiny" style="color:var(--c-warn)">${card.warnings.map(esc).join('；')}</div>` : ''}`;

  /* --- 观察与资料 --- */
  const obsHTML = (() => {
    const list = store.listObservations(plant.id);
    if (!list.length) return '<div class="tiny">还没有观察记录。有变化（花苞、黄叶等）时再拍照或说说就好。</div>';
    return list.map(o => `
      <div class="sm"><span class="k">${engine.relDay(o.stateAt)}</span><span class="v">
        ${o.tags.map(t => `<span class="cat-tag cat-stage" style="margin-right:6px">${esc(store.obsTagLabel(t))}</span>`).join('')}
        ${o.uncertain ? '<b>(疑似，待你核实)</b> ' : ''}${esc(o.text || '')}
        <br><span class="tiny">来源：${o.source === 'photo' ? '你上传的照片' : '你说/手动记录'}${o.isCurrentState ? '' : ' · <b>旧照，不作当前状态</b>'}</span>
      </span></div>`).join('');
  })();

  const extrasHTML = k ? Object.entries(k.extras || {}).map(([kk, vv]) =>
    `<div class="sm"><span class="k">${esc(kk)}</span><span class="v">${esc(vv)}</span></div>`).join('') : '';

  const identitySource = { knowledge: '来自常见植物库（你建档时选择）', manual: '你手动填写', pending: '待确认' }[plant.identity.source] || '—';

  box.innerHTML = `
    <div class="subpage-inner">
      <div class="topbar">
        <button class="back" aria-label="返回" id="p-back">‹</button>
        <div class="title">${esc(plant.nickname || plant.name)}</div>
        <div class="spacer"></div>
      </div>

      <div class="plant-hero">${plant.photoIds.length ? `<img data-ph="${plant.photoIds[0]}" alt="${esc(plant.name)}">` : '<div class="noimg">植</div>'}</div>

      <div class="plant-head">
        <div class="name">${esc(plant.name)}
          ${plant.isExample ? '<span class="badge-pending">示例</span>' : ''}
          ${plant.identityPending ? '<span class="badge-pending">待确认</span>' : ''}
        </div>
        ${k && k.sci ? `<div class="sci">${esc(k.sci)}<span class="tiny" style="margin-left:8px">识别来源：${identitySource}</span></div>` : `<div class="tiny">身份：${identitySource}</div>`}
        ${plant.nickname ? `<div class="sub">平时叫「${esc(plant.nickname)}」</div>` : ''}
        <div class="mt8"><span class="family-dot"><i style="background:var(--c-primary)"></i>${esc(posName)}${fam && fam.city ? ' · ' + esc(fam.city.name) : ''}</span></div>
        <div class="chip-row mt8">${envTagsHTML}</div>
        ${notesHTML}
      </div>

      <div class="act-row mt14">
        <button class="act-btn" id="a-health">${I.cam}哪里不对</button>
        <button class="act-btn" id="a-say">${I.mic}说一说</button>
        <button class="act-btn" id="a-card">${I.card}养护小卡</button>
      </div>

      <div class="section-h"><h2>现在怎么照顾</h2><span class="tiny">${ctx ? esc(ctx.city) + ' · ' + esc(ctx.season) : ''}</span></div>
      <div class="card">${nowHTML}</div>

      <div class="section-h"><h2>位置</h2><span class="tiny">${space ? esc(space.name) : '暂未设置'}</span></div>
      ${positionCardHTML(pa, space, plant)}

      <div class="section-h"><h2>平时怎么养</h2></div>
      <div class="card">
        <details class="fold" open><summary>浇水</summary><div class="fold-body">${waterHTML}</div></details>
        ${k ? `<details class="fold"><summary>光照与摆放</summary><div class="fold-body">${esc(k.light)}</div></details>
        <details class="fold"><summary>施肥</summary><div class="fold-body">${fertHTML}</div></details>` : ''}
        ${tabooHTML ? `<details class="fold"><summary>核心禁忌</summary><div class="fold-body">${tabooHTML}</div></details>` : ''}
      </div>

      <div class="section-h"><h2>五行养护小卡</h2></div>
      <div class="card">${cardHTML}</div>

      <div class="section-h"><h2>更多资料</h2></div>
      <div class="card">
        <details class="fold"><summary>照片与观察（变化记录，非流水）</summary><div class="fold-body">${obsHTML}</div></details>
        <details class="fold"><summary>详细习性</summary><div class="fold-body">${extrasHTML || '身份确认后可查看。'}</div></details>
        <details class="fold"><summary>管理：编辑 / 删除</summary>
          <div class="fold-body">
            <div class="gap-btns" style="flex-direction:column">
              <button class="btn btn-s" id="m-edit">编辑基本信息（名称/昵称/位置/个体差异）</button>
              <button class="btn btn-danger-outline btn-s" id="m-del">删除这盆植物</button>
            </div>
            <div class="tiny mt8">删除只影响这一盆：档案、照片与观察一起删除，其他植物不受影响。</div>
          </div>
        </details>
      </div>
    </div>`;

  /* 绑定 */
  $('#p-back', box).addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/home';
  });
  $('#a-health', box).addEventListener('click', () => { location.hash = `#/health/${plant.id}`; });
  $('#a-say', box).addEventListener('click', () => { location.hash = `#/say/${plant.id}`; });
  $('#a-card', box).addEventListener('click', () => { card.ok ? showCardBig(card, plant.nickname || plant.name) : toast('身份确认后可生成小卡'); });
  $('#c-big', box)?.addEventListener('click', () => showCardBig(card, plant.nickname || plant.name));
  $('#c-copy', box)?.addEventListener('click', async () => {
    toast(await copyText(card.lines.join('\n')) ? '已复制 5 行' : '复制失败');
  });
  $('#c-save', box)?.addEventListener('click', () => {
    try {
      const img = cardImage(card.lines);
      downloadDataUrl(img.dataUrl, `${plant.nickname || plant.name}-养护小卡.png`);
      toast('已生成并开始下载黑白图片');
    } catch (e) { toast('生成失败：' + (e.message || e)); }
  });
  const sp = $('#tip-speak', box);
  if (sp) sp.addEventListener('click', () => {
    if (sp.dataset.on === '1') { stopSpeak(); sp.dataset.on = '0'; sp.textContent = '听一听这些提醒'; return; }
    const tips = engine.plantNowTips(plant.id);
    speakText(tips.map(t => `${t.title}。${t.cond}`).join('。'), () => { sp.dataset.on = '0'; sp.textContent = '听一听这些提醒'; });
    sp.dataset.on = '1'; sp.textContent = '停止朗读';
  });
  $('#m-edit', box)?.addEventListener('click', () => editSheet(plant, rerender));
  $('#m-del', box)?.addEventListener('click', () => deletePlantFlow(plant));
  hydratePhotos(box);
}

/** 照片异步水合（v3 7.4：存储分层后 getPhoto 为异步） */
async function hydratePhotos(box) {
  for (const img of box.querySelectorAll('img[data-ph]')) {
    try {
      const ph = await store.getPhoto(img.dataset.ph);
      if (ph && ph.dataUrl) img.src = ph.dataUrl;
    } catch (e) { /* 单张失败不阻塞档案页 */ }
  }
}
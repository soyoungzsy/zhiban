// ============================================================
// views/health.js — 哪里不对（v3 §3 症状排查主路径）
//
// 与旧版"拍照看看"的区别：
//   · 不需要照片、不需要浇水历史即可走完排查（T02：主路径，
//     无视觉诊病服务也完整可用）；
//   · 用户只选"看到的现象"（8 项，不出现病名）；追问最多两题、
//     逐题显示、全部可跳过（T05）；说不清不会当作"否"（T04）；
//   · 结果默认只给：1 个优先方向 + 1—3 条动作；必要时才
//     "先不要做什么"与就医提示；完整原因折叠（3.3）；
//   · 明确标注"根据用户症状 + 植物知识 + 位置档案生成"，
//     不写"照片已确认"，不给病害百分比；照片仅存档；
//   · 健康拍照不会改动植物长期位置（T12）。
// demo 参数（截图/演示）：?sym=wilt,yellow-leaf&soil=wet&move=no&go=1
//   —— sym 预选症状、soil/move 预填追问答案、go=1 直接出结果。
// ============================================================

import * as store from '../store.js';
import { findKnowledge } from '../knowledge.js';
import { $, $$, esc, toast } from '../ui.js';
import { compressImage, photoTimeInfo } from '../services.js';
import * as HR from '../health-rules.js';

let h;
function reset() {
  h = {
    photos: [],        // {dataUrl, timeInfo}
    sym: new Set(),    // 已选症状 tag
    answers: {},       // 追问答案 {soil|move: v}
    freeText: '',
    done: false, saved: false, result: null,
    demoGo: false,
  };
}

export function render(sub, args) {
  reset();
  const plant = store.getPlant(args[0]);
  if (!plant) {
    sub.innerHTML = `<div class="subpage-inner" style="padding-top:80px">
      <div class="empty">没有找到这盆植物。<br><a class="btn btn-primary mt14" style="display:inline-flex" href="#/home">回到首页</a></div></div>`;
    return;
  }
  /* demo 预选（直接可截图的场景参数；正常用户不受影响） */
  try {
    const params = new URLSearchParams(location.search);
    const sym = params.get('sym');
    if (sym) for (const t of sym.split(',')) if (HR.SYMPTOMS.some(s => s.tag === t)) h.sym.add(t);
    if (params.get('soil')) h.answers.soil = params.get('soil');
    if (params.get('move')) h.answers.move = params.get('move');
    if (params.get('go') === '1') h.demoGo = true;
  } catch (e) { /* 无 location 环境忽略 */ }
  draw(sub, plant);
}

/* ---------------- 结果区（3.3 结构） ---------------- */

function resultHTML(r, isa) {
  if (r.needsInput) return `<div class="note note-warn">${esc(r.hint)}</div>`;
  return `
    <div class="result-step"><h4>① 优先排查方向</h4><div class="rs-body">
      <b>${esc(r.direction.title)}</b>——${esc(r.direction.text)}</div></div>
    <div class="result-step"><h4>② 现在先做</h4><div class="rs-body">
      ${r.actions.map(a => `<b>·</b> ${esc(a)}`).join('<br>')}</div></div>
    ${r.avoid ? `<div class="result-step"><h4>先不要做什么</h4><div class="rs-body">${esc(r.avoid)}</div></div>` : ''}
    ${r.escalation ? `<div class="result-step"><h4>什么情况要再上心</h4><div class="rs-body">${esc(r.escalation)}</div></div>` : ''}
    ${(r.folded.likely || r.folded.alternative) ? `
    <details class="fold"><summary>完整原因与替代可能（不展开不影响照做）</summary><div class="fold-body">
      ${r.folded.likely ? `<b>详细解释：</b>${esc(r.folded.likely)}<br>` : ''}
      ${r.folded.alternative ? `<b>其他可能：</b>${esc(r.folded.alternative)}` : ''}
    </div></details>` : ''}
    <div class="tiny mt8">根据${esc(r.basis)} 生成${isa ? '（身份未确认，方向偏通用）' : ''}；<b>照片分析未接入</b>，本结果不构成确诊；用药以产品标签为准，本应用不给剂量。</div>
    ${h.saved ? `<div class="note mt8">本次排查（含你选的现象${h.photos.length ? '与照片' : ''}）已记入这盆的档案——只是记录变化，不需要任何确认或打卡。</div>` : ''}`;
}

/* ---------------- 主体 ---------------- */

function draw(sub, plant) {
  const fam = store.getFamily(plant.familyId);
  const k = findKnowledge(plant.knowledgeKey);
  const space = plant.spaceId ? store.getSpace(plant.spaceId) : null;
  const isa = plant.identityPending || !k;
  const fups = HR.followUpsFor(k, [...h.sym]);
  /* 症状纠正后，不留已失效的旧追问答案（v3 3.2） */
  for (const key of Object.keys(h.answers)) if (!fups.some(f => f.id === key)) delete h.answers[key];
  const oldDetected = h.photos.some(p => p.timeInfo.old);
  const posName = space ? space.name : (plant.env.position || '暂未设置');

  sub.innerHTML = `
    <div class="subpage-inner">
      <div class="topbar">
        <button class="back" id="h-back" aria-label="返回">‹</button>
        <div class="title">哪里不对 · ${esc(plant.nickname || plant.name)}</div>
        <div class="spacer"></div>
      </div>

      <div class="note note-warn mb8"><span class="badge-offline">照片健康分析未接入</span>
        只选"看到的现象"（可多选）+ 最多两题小追问，就能得到排查方向——<b>不拍照也可以</b>，也不需要先补浇水历史（T02）。照片只作本次记录存档。</div>

      <div class="card">
        <div class="tiny">已自动关联：<b>${esc(plant.name)}</b>${fam && fam.city ? ' · ' + esc(fam.city.name) : ''} · 位置「${esc(posName)}」。
        在这里拍照<b>不会改动</b>它的长期位置；身份${isa ? '未确认，方向偏通用' : '已知，按品种'}</div>
      </div>

      <div class="card">
        <div class="field"><label>① 先选看到的现象（可多选；不用知道病名）</label>
          <div class="chip-row">
            ${HR.SYMPTOMS.map(s => `<span class="chip ${h.sym.has(s.tag) ? 'on' : ''}" data-sym="${s.tag}">${esc(s.label)}<span class="tiny" style="display:block;font-weight:400">${esc(s.hint)}</span></span>`).join('')}
          </div>
        </div>

        ${fups.length ? `
        <div class="field"><label>② 关键追问（可以都跳过；答案只用于本次判断）</label>
          ${fups.map(f => `
          <div class="note note-plain mt8">
            <div>${esc(f.ask)}</div>
            <div class="chip-row mt8">
              ${f.options.map(o => `<span class="chip ${h.answers[f.id] === o.v ? 'on' : ''}" data-fid="${f.id}" data-v="${o.v}">${esc(o.t)}</span>`).join('')}
            </div>
            ${f.why ? `<div class="tiny mt8">${esc(f.why)}</div>` : ''}
          </div>`).join('')}
        </div>` : '<div class="tiny mb8">选好现象后，如有必要这里会出现一两个追问。</div>'}

        ${h.sym.has('other') ? `
        <div class="field"><label>再描述一两句（看不到的不算：哪里、什么颜色、几片）</label>
          <textarea class="textarea" id="h-text" placeholder="例：靠窗那侧的三四片叶子，叶面有黑色小点，摸着不黏">${esc(h.freeText)}</textarea>
        </div>` : ''}

        <button class="btn btn-primary btn-block" id="h-go">${h.done ? '再看一次排查方向' : '看看排查方向'}</button>
        <div class="tiny mt8 center">想得不准随时改选项再点一次——每次都按当前选择重新判断。</div>
      </div>

      ${h.photos.length ? `
      <div class="card">
        <div class="field"><label>本次照片（可选，只存档；文件时间≠拍摄时间）</label>
          <div class="photo-thumbs">
            ${h.photos.map((p, i) => `
              <div class="th"><img src="${p.dataUrl}" alt="照片${i + 1}">
                <button class="del" data-i="${i}" aria-label="删除这张">✕</button></div>`).join('')}
          </div>
          <div class="tiny mt8">${oldDetected ? '有较旧的文件时间——这些照片只当资料，不作为当前状态。' : '按文件时间看照片较新；旧照可删除后不带。'}</div>
          <div class="row mt8">
            <label class="btn btn-s" for="h-cam">补拍一张</label>
            <input type="file" id="h-cam" accept="image/*" capture="environment" hidden>
            <label class="btn btn-s" for="h-file" style="margin-left:10px">从相册加</label>
            <input type="file" id="h-file" accept="image/*" multiple hidden>
          </div>
        </div>
      </div>` : `
      <div class="card center">
        <div class="tiny">想存一张现场照片吗（可选）？</div>
        <div class="row mt8" style="justify-content:center">
          <label class="btn btn-s" for="h-cam">拍一张</label>
          <input type="file" id="h-cam" accept="image/*" capture="environment" hidden>
          <label class="btn btn-s" for="h-file" style="margin-left:10px">从相册选</label>
          <input type="file" id="h-file" accept="image/*" multiple hidden>
        </div>
      </div>`}

      ${h.done ? `
      <div class="section-h"><h2>排查方向</h2><span class="tiny">依据你的选择，非检测结论</span></div>
      <div class="card">${resultHTML(h.result, isa)}</div>` : ''}
    </div>`;

  $('#h-back', sub).addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/home';
  });

  /* 症状与追问 */
  $$('[data-sym]', sub).forEach(c => c.addEventListener('click', () => {
    const t = c.dataset.sym;
    h.sym.has(t) ? h.sym.delete(t) : h.sym.add(t);
    draw(sub, plant);
  }));
  $$('[data-fid]', sub).forEach(c => c.addEventListener('click', () => {
    h.answers[c.dataset.fid] = c.dataset.v;
    draw(sub, plant);
  }));
  const ta = $('#h-text', sub);
  if (ta) ta.addEventListener('input', () => { h.freeText = ta.value; });

  /* 照片（可选） */
  [$('#h-cam', sub), $('#h-file', sub)].forEach(inp => inp.addEventListener('change', async e => {
    for (const f of e.target.files) {
      try { h.photos.push({ dataUrl: await compressImage(f), timeInfo: photoTimeInfo(f) }); }
      catch (err) { toast('一张照片读取失败'); }
    }
    e.target.value = '';
    draw(sub, plant);
  }));
  $$('.photo-thumbs .del', sub).forEach(b => b.addEventListener('click', () => {
    h.photos.splice(+b.dataset.i, 1);
    draw(sub, plant);
  }));

  /* 主行动：排查 + 一次性存档 */
  $('#h-go', sub).addEventListener('click', () => go(sub, plant));

  /* demo：go=1 直接出结果（截图/演示路径，等同手动点按钮） */
  if (h.demoGo) { h.demoGo = false; go(sub, plant); }
}

async function go(sub, plant) {
  const k = findKnowledge(plant.knowledgeKey);
  const space = plant.spaceId ? store.getSpace(plant.spaceId) : null;

  /* 首次点按钮：把照片与"现象"记入档案（变化记录，非流水） */
  if (!h.done && !h.saved) {
    const oldDetected = h.photos.some(p => p.timeInfo.old);
    let firstPhotoId = null, photoFail = 0;
    for (const p of h.photos) {
      try {
        const ph = await store.savePhoto(p.dataUrl, { capturedAt: p.timeInfo.ts, oldPhoto: p.timeInfo.old });
        plant.photoIds.push(ph.id);
        if (!firstPhotoId) firstPhotoId = ph.id;
      } catch (e) { photoFail++; }
    }
    if (photoFail) toast(`${photoFail} 张照片空间不足没存上（档案其他内容正常）`);
    const tags = [...h.sym].filter(t => store.OBS_TAGS[t]);
    const ansBits = Object.entries(h.answers)
      .filter(([, v]) => v && v !== 'unsure')
      .map(([kk, vv]) => ({ soil: `盆土${vv === 'wet' ? '偏湿' : '偏干'}`, move: '近期有环境变动' }[kk]));
    const text = '排查记录' + (h.freeText ? '：' + h.freeText.trim() : '') + (ansBits.length ? '（' + ansBits.join('，') + '）' : '') + (oldDetected ? '；附较旧的资料照，不作当前状态' : '');
    if (tags.length || h.freeText.trim()) {
      store.addObservation({
        plantId: plant.id, tags, text: text.trim(),
        source: 'user', photoId: firstPhotoId,
        isCurrentState: !oldDetected,
      });
    }
    store.save();
    h.saved = true;
  }

  h.result = HR.assess({
    plant,
    k, space,
    symTags: [...h.sym], answers: h.answers, freeText: h.freeText,
  });
  if (!h.result.needsInput) h.done = true;
  else if (!h.sym.size) toast('先选一个看到的现象');
  draw(sub, plant);
}
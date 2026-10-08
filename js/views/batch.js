// ============================================================
// js/views/batch.js — 整屋照片批量建档（v4 §2）
//
// 流程：上传照片 → 服务识别定位 → 编号框+候选卡（勾选/纠正/删除/补选/合并）
//       → 位置草稿 →「建立所选 N 盆档案」一批保存为独立档案。
// 红线：识别结果先存草稿，取消不建正式植物；摘要从实际检测结果计算，
//      不信模型自报总数；同种两盆默认保留两个实例，合并必须用户确认；
//      演示模式明示"非真实识别"；服务未配置不冒充成功。
// ============================================================
import * as store from '../store.js';
import * as HM from '../home-model.js';
import { $, $$, esc, toast, confirmDlg, openSheet } from '../ui.js';
import { compressImage, photoTimeInfo } from '../services.js';
import * as V from '../vision.js';
import { searchKnowledge, findKnowledge } from '../knowledge.js';

let st;
function reset() {
  st = {
    phase: 'upload',          // upload | detecting | review | done
    photos: [],               // {photoIdx, savedPhotoId, analysis, detectOk?, error?, msg?}
    detections: [], hints: [],
    health: undefined, progressText: '',
    abort: null, committing: false, result: null,
  };
}

export function render(root, args) {
  reset();
  const draft = store.loadBatchDraft();
  if (draft && Array.isArray(draft.detections) && draft.detections.length) {
    st.detections = draft.detections;
    st.doneInDraft = Array.isArray(draft.done) ? draft.done : [];
    st.photos = (draft.photoIds || []).map((pid, i) => ({ photoIdx: i, savedPhotoId: pid, detectOk: true }));
    st.hints = V.planDuplicateHints(st.detections.filter(d => !d.merged && !d.removed));
    st.phase = 'review';
    st.restored = true;
  }
  draw(root);
  if (st.health === undefined) {
    // 联通检查：成功时保留 /api/health 返回对象（healthRaw）——演示模式提示与
    // 上传区都依赖它；失败（服务未启动）如实置 0，页面只给启动说明。
    V.visionHealth().then(h => { st.healthRaw = h || null; st.health = h ? 1 : 0; draw(root); })
      .catch(() => { st.health = 0; draw(root); });
  }
}

/* ---------------- 草稿持久（返回/重试不丢已确认编辑，§2.9） ---------------- */
function draftJson() {
  return {
    homeId: (HM.currentHome() || {}).id || null,
    photoIds: st.photos.map(p => p.savedPhotoId),
    done: st.doneInDraft || [],
    detections: st.detections,
  };
}
function persistDraft() { store.saveBatchDraft(draftJson()); }

/** 候选名 → 知识库键（仅精确命中内置 13 种时关联；库外/自定义名保持 null，
 *  绝不硬套——与 add.js 手动建档语义一致，§2.6/§3）。 */
function keyOfName(name) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const hit = searchKnowledge(nm).find(k => k.name === nm || k.aliases.some(a => a === nm));
  return hit ? hit.key : null;
}

/* ---------------- 照片上传：存档原图(1024)入一个 photoId；分析图(1408)只进内存 ---------------- */
async function addPhotos(root, files) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast('有一张照片太大（>25MB），换一张'); continue; }
    try {
      const t = photoTimeInfo(f);
      const archive = await compressImage(f, V.ARCHIVE_MAX_SIDE, 0.8);
      const ph = await store.savePhoto(archive, { capturedAt: t.known ? t.ts : null, oldPhoto: t.old });
      if (!ph) throw new Error('photo-save-failed');
      const analysis = await compressImage(f, V.VISION_MAX_SIDE, 0.86);
      st.photos.push({ photoIdx: st.photos.length, savedPhotoId: ph.id, analysis });
    } catch (e) { toast('有一张照片没能保存（本机空间不足？）——这张跳过'); }
  }
  draw(root);
}

/* ---------------- 识别：逐图、并发受限、可取消、单图失败不清空整批 ---------------- */
async function runDetect(root) {
  if (!st.photos.length) return toast('先选照片');
  if (!st.photos.some(p => p.analysis)) return toast('已恢复的草稿没有分析图——重新上传一张再试');
  st.phase = 'detecting'; st.progressText = '准备识别…'; draw(root);
  const ctrl = new AbortController(); st.abort = ctrl;
  const results = await V.detectPhotos(st.photos.map(p => p.analysis), {
    signal: ctrl.signal,
    onProgress: (n, t) => { st.progressText = `识别中：${n}/${t} 张`; draw(root); },
  });
  st.detections = [];
  for (const r of results) {
    const photo = st.photos[r.photoIdx];
    if (!photo) continue;
    if (r.status === 'ok') {
      photo.detectOk = true; photo.error = null;
      for (const det of r.detections) {
        if (!st.detections.some(x => x.photoIdx === r.photoIdx && JSON.stringify(x.box) === JSON.stringify(det.box))) {
          st.detections.push({
            detectionId: store.uid(), photoIdx: r.photoIdx, photoId: photo.savedPhotoId,
            box: det.box, candidates: det.candidates || [], scene: det.scene || [],
            selected: true, merged: false, removed: false,
            chosenName: (det.candidates && det.candidates[0] && det.candidates[0].name) || '',
            chosenKey: keyOfName(det.candidates && det.candidates[0] && det.candidates[0].name),
            spaceId: null, spaceDraft: '',
          });
        }
      }
    } else { photo.detectOk = false; photo.error = r.error; photo.msg = r.msg || ''; }
  }
  st.hints = V.planDuplicateHints(st.detections);
  st.phase = st.detections.length || st.photos.some(p => p.error) ? 'review' : 'review';
  st.doneInDraft = st.doneInDraft || [];
  persistDraft();
  draw(root);
}

/* ---------------- 位置草稿（§4：照片线索→中性名，绝不猜房间用途） ---------------- */
const SCENE_DRAFT = ([['靠窗', '窗边位置'], ['窗帘', '窗帘边位置'], ['架子', '架子位置'], ['落地', '落地位置'], ['悬挂', '挂放位置']]);
function draftNameOf(d) {
  const k = (d.scene && d.scene[0]) || '';
  for (const [re, name] of SCENE_DRAFT) if (k.includes(re)) return name;
  return '';
}
function applySceneGroups() {
  const idx = { };
  for (const d of st.detections) {
    const name = draftNameOf(d);
    if (!name) { d.spaceDraft = ''; continue; }
    const key = d.scene.join('|');
    const n = idx[key] = (idx[key] || 0) + 1;
    const suffix = String.fromCharCode(64 + n);
    d.spaceDraft = `${name}${suffix}`;   // "窗边位置A"——中性名，不写成卧室/南阳台
  }
}

/* ---------------- 提交（幂等一批保存为独立档案） ---------------- */
async function commitAll(root) {
  const chosen = st.detections.filter(d => d.selected && !d.merged && !d.removed && !(st.doneInDraft || []).includes(d.detectionId));
  if (!chosen.length) return toast('先勾选要建的盆');
  const home = HM.ensureHome();
  if (!home) { toast('先选择"我的家"（多家庭迁移）'); location.hash = '#/spaces'; return; }

  const ok = await confirmDlg({
    title: `建立所选 ${chosen.length} 盆档案？`,
    okText: '建立档案',
    body: '每盆一个独立档案；照片局部图作为各自主图，原图共享一份。<br>识别候选只是初始名字，之后可在每盆档案里随时更正。',
  });
  if (!ok) return;
  st.committing = true; draw(root);

  /* 位置草稿 → 实际 spaceId（同草稿名只建一次；失败降级暂未设置不阻断建档） */
  const createdSpaces = {};
  for (const d of chosen) {
    if (d.spaceId) continue;
    const dn = (d.spaceDraft || '').trim();
    if (!dn || dn === '暂未设置') continue;
    if (!createdSpaces[dn]) createdSpaces[dn] = store.addSpace({ homeId: home.id, name: dn });
    d.spaceId = createdSpaces[dn] ? createdSpaces[dn].id : null;
  }

  const batch = {
    homeId: home.id,
    photoIds: st.photos.map(p => p.savedPhotoId),
    done: st.doneInDraft || [],
    detections: st.detections,
  };
  const r = await store.commitBatch(batch, {
    /* 注意：commitBatch 内部会把成功项的 detectionId 写进 b.done（同一数组引用），
       这里绝不能再把 plantId 混入 done——重试跳过判断只认 detectionId。 */
    makeCrop: async (d) => {
      const ph = await store.getPhoto(d.photoId);
      if (!ph || !ph.dataUrl) return null;
      try { return await V.cropPhoto(ph.dataUrl, d.box); } catch (e) { return null; }
    },
  });
  st.result = r;
  persistDraft();
  st.committing = false;
  st.phase = 'done';
  draw(root);
}

/* ---------------- 绘制 ---------------- */
function draw(root) {
  const home = HM.currentHome();
  if (HM.needsHomePick()) {
    root.innerHTML = `<div class="empty" style="padding-top:60px"><div class="e-icon">家</div><b>先选择"我的家"</b>
      <div class="mt8">检测到多个家庭：选一个继续，其余原样归档保留。</div>
      <a class="btn btn-primary mt14" href="#/spaces" style="display:inline-flex">去选择我的家</a></div>`;
    return;
  }
  const md = st.mode = (st.health === undefined ? 'checking' : (st.health ? 'ok' : 'offline'));

  if (st.phase === 'review' || st.phase === 'done') applySceneGroups();

  let html = `<div class="section-h"><h2>整屋照片建档</h2><span class="tiny">一次照片 → 多盆档案</span></div>`;

  if (st.restored) html += `<div class="note note-plain mb8">已恢复上次的批次草稿——你的勾选与更正都还在；确认后从「建立所选…」继续，或从头开始。</div>`;

  if (st.phase === 'upload') {
    html += `
    ${md === 'checking' ? `<div class="note note-plain mb8">正在检查识别服务…</div>` : ''}
    ${st.healthRaw ? healthNote(st.healthRaw) : (md === 'offline'
      ? `<div class="card note-warn"><b>识别服务未启动</b><div class="tiny mt8">要用识别，请在项目目录启动：<code>node server/server.js</code>（凭证见 server/.env.example）。没有识别不影响手动建档。</div>
         <a class="btn btn-outline mt8" href="#/add" style="display:inline-flex">先去手动建档</a></div>` : '')}
    ${(st.healthRaw && (st.healthRaw.vision.mode === 'live-ready' || st.healthRaw.vision.mode === 'mock'))
      ? `
    <div class="card">
      <div class="field"><label>① 选整屋或整面照片（可多张；不同角度更好）</label>
        <label class="photo-add" for="b-file">从相册选照片</label>
        <input type="file" id="b-file" accept="image/*" multiple hidden>
        ${st.photos.length ? `<div class="tiny mt8">已加 ${st.photos.length} 张</div>` : '<div class="tiny mt8">镜头外和被遮挡的植物无法识别——拍不到的之后可手动补一盆。</div>'}
      </div>
      ${st.photos.length ? `<button class="btn btn-primary btn-block" id="b-detect">${st.photos.length > 1 ? `识别这 ${st.photos.length} 张照片` : '识别这张照片'}</button>` : ''}
    </div>` : ''}`;
  } else if (st.phase === 'detecting') {
    html += `<div class="card"><div class="sub">${esc(st.progressText || '识别中…')}</div>
      <div class="tiny mt8">每张照片独立识别：某张失败不影响其他照片，稍后可单独重试。</div>
      <button class="btn btn-outline mt8" id="b-cancel">取消识别</button></div>`;
  } else if (st.phase === 'review') {
    const counts = V.summarizeCounts(st.detections);
    const chosenN = st.detections.filter(d => d.selected && !d.merged && !d.removed).length;
    html += `
    <div class="note note-plain mb8">这些照片中发现约 <b>${counts.known}</b> 盆可辨认植物，另有 <b>${counts.pending}</b> 处待确认。
      <span class="tiny">（识别只针对照片里看得见的地方——镜头外和被遮挡的部分保持未知。）</span></div>
    ${photoCard()}
    ${st.hints.length ? hintsCard() : ''}
    ${detCards()}
    <div class="gap-btns mt8">
      <button class="btn btn-outline" id="b-allon">全部选中</button>
      <button class="btn btn-outline" id="b-alloff">全部取消</button>
    </div>
    <button class="btn btn-primary btn-block mt8" id="b-commit" ${st.committing ? 'disabled' : ''}>${st.committing ? '保存中…' : `建立所选 ${chosenN} 盆档案`}</button>
    <div class="tiny mt8 center">取消或返回不会建任何档案；草稿保留，下次进来接着改。</div>`;
  } else if (st.phase === 'done') {
    const r = st.result || { created: [], failed: [] };
    const okNames = r.created.map(pid => (store.getPlant(pid) || {}).name).filter(Boolean);
    html += `
    <div class="card">
      <b>已建立 ${r.created.length} 盆档案</b>
      ${okNames.length ? `<div class="tiny mt8">${okNames.map(esc).join('、')}</div>` : ''}
      ${r.failed && r.failed.length ? `<div class="sub mt8" style="color:var(--danger,#c0392b)">有 ${r.failed.length} 盆没建成（本机存储空间不足？）——你的勾选保留着，处理好空间回来点"重试失败项"。</div>` : ''}
    </div>
    <div class="gap-btns mt8">
      ${r.failed && r.failed.length ? `<button class="btn btn-outline" id="b-retry">重试失败项</button>` : ''}
      <a class="btn btn-primary" href="#/home" style="display:inline-flex">回首页看看</a>
    </div>`;
  }

  root.innerHTML = html;
  bind(root);
}

function healthNote(h) {
  st.healthRaw = h;
  const vm = h && h.vision;
  if (!vm) return '';
  if (vm.mode === 'mock') return `<div class="note note-warn mb8"><b>演示模式</b>——识别返回的是固定示例结果，<b>不是真实识别</b>（MOCK_VISION=1 启动时的流程演示）。</div>`;
  if (vm.mode === 'missing-key') return `<div class="card note-warn"><b>识别未配置</b><div class="tiny mt8">${esc(vm.msg || '')}——可以先用手动建档，或以演示模式体验整批流程。</div></div>`;
  return '';
}

function photoCard() {
  return `<div class="card">${st.photos.map(p => {
    const dets = st.detections.filter(d => d.photoIdx === p.photoIdx && !d.removed);
    const boxes = dets.map((d, i) => {
      const n = st.detections.indexOf(d) + 1;
      return `<div class="bbox ${d.merged ? 'bbox-merged' : ''}" data-addx="1"
        style="left:${(d.box.x * 100).toFixed(1)}%;top:${(d.box.y * 100).toFixed(1)}%;width:${(d.box.w * 100).toFixed(1)}%;height:${(d.box.h * 100).toFixed(1)}%"><span>${d.merged ? '±' : n}</span></div>`;
    }).join('');
    return `<div class="batch-photo mb8">
      <div class="bp-wrap"><img src="data:" alt="照片${p.photoIdx + 1}照片" data-ph="${p.savedPhotoId}" data-add="1">
        ${boxes}
        ${p.error ? `<div class="tiny mt8" style="color:var(--danger,#c0392b)">这张识别失败：${esc(p.msg || p.error)} <button class="btn btn-s" data-retryphoto="${p.photoIdx}">重试这张</button></div>` : ''}
      </div>
      <div class="tiny">照片 ${p.photoIdx + 1}——点击图上没框住的地方可以补选一盆（待确认）</div>
    </div>`;
  }).join('')}</div>`;
}

function hintsCard() {
  return `<div class="card note-plain"><b>可能有重复的两盆，请确认</b>
    ${st.hints.map(h => {
      const a = st.detections.findIndex(d => d.detectionId === h.a) + 1;
      const b = st.detections.findIndex(d => d.detectionId === h.b) + 1;
      const bDet = st.detections.find(d => d.detectionId === h.b);
      return `<div class="sub mt8">${esc(h.reason)}
        <div class="gap-btns mt8">
          <button class="btn btn-s btn-outline" data-keepdup="$${h.b}">保留两盆（独立档案）</button>
          <button class="btn btn-s btn-outline" data-merge="$${h.b}" ${bDet && bDet.merged ? 'disabled' : ''}>${bDet && bDet.merged ? '已按同一盆合并' : '是同一盆，合并（只留一盆）'}</button>
        </div></div>`;
    }).join('')}</div>`;
}

function detCards() {
  return st.detections.map((d, i) => {
    const n = i + 1;
    if (d.removed) {
      return `<div class="card note-plain"><div class="sub"><s>第 ${n} 处</s> 已按误检删除
        <button class="btn btn-s btn-outline" data-restore="${d.detectionId}">恢复</button></div></div>`;
    }
    const pending = !d.candidates.length;
    const chip = (pending)
      ? `<span class="chip on">身份待确认</span>`
      : d.candidates.map((c, j) => `<span class="chip ${d.chosenName === c.name ? 'on' : ''}" data-cname="${esc(c.name)}" data-ci="${j}">${esc(c.name)}<span class="tiny">${c.confidence === 'high' ? '把握较高' : c.confidence === 'medium' ? '有一定把握' : '把握偏低'}</span></span>`).join('');
    const known = pending || !d.chosenName;
    return `<div class="card ${d.merged ? 'op-50' : ''}" data-det="${d.detectionId}">
      <div class="row">
        <span class="bbox-n">${d.merged ? '±' : n}</span>
        <span class="chip ${d.selected ? 'on' : ''}" data-togsel="${d.detectionId}">${d.selected ? '选中建档' : '不建这盆'}</span>
        <span class="grow"></span>
        <button class="btn btn-s btn-outline" data-remove="${d.detectionId}">误检，删除</button>
      </div>
      ${d.merged ? `<div class="tiny mt8">已与另一处按"同一盆"合并——这盆不重复建。</div>` : `
      <div class="chip-row mt8">${chip}</div>
      <div class="tiny mt8">${known
        ? '这里没认出名字——先按「待确认植物」建，看到实物后在档案里说一句"这是XX"就能更新。'
        : `将按「${esc(d.chosenName)}」建档${d.chosenKey ? '' : '（名字先记着，具体养护这版知识库里没有就不瞎编）'}。`}</div>
      <div class="row mt8"><span class="tiny grow">位置：${esc(d.spaceId ? (store.getSpace(d.spaceId) || {}).name : d.spaceDraft || '暂未设置')}</span>
        <button class="btn btn-s btn-outline" data-pickspace="${d.detectionId}">${d.spaceId || d.spaceDraft ? '改位置' : '选位置'}</button></div>`}
    </div>`;
  }).join('');
}

/* ---------------- 事件 ---------------- */
function bind(root) {
  const f = $('#b-file', root);
  if (f) f.addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await addPhotos(root, files); });
  const det = $('#b-detect', root);
  if (det) det.addEventListener('click', () => runDetect(root));
  const cancel = $('#b-cancel', root);
  if (cancel) cancel.addEventListener('click', () => { if (st.abort) st.abort.abort(); st.phase = 'upload'; draw(root); });
  $$('[data-ph]', root).forEach(img => {
    if (!(window.__zhibanHydratePhotos)) return;
  });
  // 照片水合（batch 用存档 dataUrl 直接显示——与 photos 分层一致）
  $$('.bp-wrap img[data-ph]', root).forEach(async img => {
    const ph = await store.getPhoto(img.dataset.ph);
    if (ph && ph.dataUrl) { img.src = ph.dataUrl; }
  });
  $$('[data-retryphoto]', root).forEach(b => b.addEventListener('click', async () => {
    const p = st.photos[+b.dataset.retryphoto];
    const results = await V.detectPhotos([p.analysis]);
    const r = results[0];
    if (r.status === 'ok') {
      p.detectOk = true; p.error = null;
      for (const det of r.detections) {
        if (!st.detections.some(x => x.photoIdx === p.photoIdx && JSON.stringify(x.box) === JSON.stringify(det.box))) {
          st.detections.push({ detectionId: store.uid(), photoIdx: p.photoIdx, photoId: p.savedPhotoId, box: det.box, candidates: det.candidates || [], scene: det.scene || [], selected: true, merged: false, removed: false, chosenName: (det.candidates && det.candidates[0] && det.candidates[0].name) || '', chosenKey: keyOfName(det.candidates && det.candidates[0] && det.candidates[0].name), spaceId: null, spaceDraft: '' });
        }
      }
      st.hints = V.planDuplicateHints(st.detections.filter(d => !d.merged && !d.removed));
      persistDraft(); draw(root);
    } else { toast('重试仍失败：' + (r.msg || r.error)); }
  }));
  $$('.bp-wrap[data-add]', root).forEach(w => w.addEventListener('click', e => {
    if (e.target.closest('.bbox') || e.target.closest('[data-retryphoto]')) return;
    const r = w.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - r.left) / r.width - .07, 0), .92);
    const y = Math.min(Math.max((e.clientY - r.top) / r.height - .07, 0), .92);
    const photoIdx = st.photos.findIndex(p => p.savedPhotoId === w.querySelector('img')?.dataset.ph);
    st.detections.push({ detectionId: store.uid(), photoIdx, photoId: st.photos[photoIdx]?.savedPhotoId, box: { x: +x.toFixed(3), y: +y.toFixed(3), w: .14, h: .14 }, candidates: [], scene: [], selected: true, merged: false, removed: false, chosenName: '', chosenKey: null, spaceId: null, spaceDraft: '' });
    persistDraft(); draw(root);
  }));
  $$('[data-cname]', root).forEach(c => c.addEventListener('click', () => {
    const card = c.closest('[data-det]'); const d = st.detections.find(x => x.detectionId === card.dataset.det);
    d.chosenName = c.dataset.cname;
    const hit = searchKnowledge(d.chosenName).find(k => k.name === d.chosenName || k.aliases.some(a => a === d.chosenName));
    d.chosenKey = hit ? hit.key : null;
    persistDraft(); draw(root);
  }));
  $$('[data-togsel]', root).forEach(c => c.addEventListener('click', () => {
    const d = st.detections.find(x => x.detectionId === c.dataset.togsel); d.selected = !d.selected; persistDraft(); draw(root);
  }));
  $$('[data-remove]', root).forEach(b => b.addEventListener('click', () => {
    const d = st.detections.find(x => x.detectionId === b.dataset.remove); d.removed = true; d.selected = false;
    persistDraft(); draw(root);
  }));
  $$('[data-restore]', root).forEach(b => b.addEventListener('click', () => {
    const d = st.detections.find(x => x.detectionId === b.dataset.restore); d.removed = false; d.selected = true; persistDraft(); draw(root);
  }));
  $$('[data-merge]', root).forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.merge.slice(1); const d = st.detections.find(x => x.detectionId === id);
    if (!d) return;
    d.merged = true; d.selected = false;
    st.hints = st.hints.filter(h => h.a !== d.detectionId && h.b !== d.detectionId);
    persistDraft(); draw(root);
  }));
  $$('[data-keepdup]', root).forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.keepdup.slice(1);
    st.hints = st.hints.filter(h => !(h.a === id || h.b === id));
    persistDraft(); draw(root);
  }));
  $$('[data-pickspace]', root).forEach(b => b.addEventListener('click', () => openSpacePicker(b.dataset.pickspace, root)));
  const allon = $('#b-allon', root); if (allon) allon.addEventListener('click', () => { st.detections.forEach(d => { if (!d.merged && !d.removed) d.selected = true; }); persistDraft(); draw(root); });
  const alloff = $('#b-alloff', root); if (alloff) alloff.addEventListener('click', () => { st.detections.forEach(d => d.selected = false); persistDraft(); draw(root); });
  const commit = $('#b-commit', root); if (commit) commit.addEventListener('click', () => commitAll(root));
  const retry = $('#b-retry', root); if (retry) retry.addEventListener('click', () => { st.phase = 'review'; draw(root); });
}

function openSpacePicker(detectionId, root) {
  const d = st.detections.find(x => x.detectionId === detectionId);
  if (!d) return;
  const home = HM.currentHome() || HM.ensureHome();
  const spaces = home ? store.listSpaces(home.id) : [];
  const groupKey = d.scene.join('|');
  const sameGroup = st.detections.filter(x => x.scene.join('|') === groupKey && !x.merged && !x.removed).length;
  const sheet = openSheet(`
    <h3>这盆放在哪</h3>
    <div class="sub">照片里看到的：${d.scene.length ? esc(d.scene.join('、')) + '——' : ''}推测只是草稿，<b>你可以改</b>；同一处环境的植物可以一次选好。</div>
    <div class="chip-row mt8">
      <span class="chip ${!d.spaceId && !d.spaceDraft ? 'on' : ''}" data-sp="none">暂未设置</span>
      ${spaces.map(sp => `<span class="chip ${d.spaceId === sp.id ? 'on' : ''}" data-sp="${sp.id}">${esc(sp.name)}</span>`).join('')}
    </div>
    <div class="row mt8">
      ${d.spaceDraft ? `<span class="chip ${d.spaceId ? '' : 'on'}" data-sp="draft">${esc(d.spaceDraft)}（新建）</span>` : ''}
      <input class="input grow" id="bp-name" placeholder="或写一个位置名（一次建好，多盆复用）">
    </div>
    ${sameGroup > 1 ? `<div class="row mt8"><span class="chip on" id="bp-allgroup">照片里同一处的 ${sameGroup} 盆一起用这个位置</span></div>` : ''}
    <button class="btn btn-primary btn-block" id="bp-save">就这样</button>`);
  let applyToAll = true;
  const grp = $('#bp-allgroup', sheet.root);
  if (grp) { let on = true; grp.addEventListener('click', () => { on = !on; grp.classList.toggle('on', on); applyToAll = on; }); }
  $$('.chip[data-sp]', sheet.root).forEach(c => c.addEventListener('click', () => {
    $$('.chip[data-sp]', sheet.root).forEach(x => x.classList.remove('on')); c.classList.add('on');
    c.dataset.picked = '1'; $$('.chip[data-sp]', sheet.root).forEach(x => { if (x !== c) delete x.dataset.picked; });
  }));
  $('#bp-save', sheet.root).addEventListener('click', () => {
    const picked = $('.chip[data-sp].on', sheet.root);
    let spaceId = null;
    if (picked && picked.dataset.sp === 'draft') spaceId = 'draft';
    else if (picked && picked.dataset.sp && picked.dataset.sp !== 'none') spaceId = picked.dataset.sp;
    else if (picked && picked.dataset.sp === 'none') spaceId = null;
    const custom = ($('#bp-name', sheet.root).value || '').trim();
    let newSpace = null;
    if (custom) newSpace = store.addSpace({ homeId: home.id, name: custom });
    const apply = (x) => {
      if (custom && newSpace) x.spaceId = newSpace.id;
      else if (spaceId === 'draft') x.spaceDraft = x.spaceDraft || d.spaceDraft || '';
      else x.spaceId = spaceId;
    };
    apply(d);
    if (applyToAll && sameGroup > 1) {
      for (const x of st.detections) if (x.scene.join('|') === groupKey && !x.merged && !x.removed) apply(x);
    }
    persistDraft(); sheet.close(); draw(root);
  });
}
// ============================================================
// views/add.js — 拍照建档（v3 单家庭 + 轻量位置版）
//
// 流程：拍照/选图 → 一次整理 → 一次保存。
//
// v3 变化：
//   · 不再选择家庭——保存时自动建立「我的家」（T01：不建家先建档，
//     城市与位置都可后补）；多家庭待迁移时先选家，不替用户决定；
//   · 摆放位置（T06）：复用已登记位置，或输入名字当场轻建；
//     允许"暂未设置"；环境问卷不在这一步重复（到「摆放位置」一次填多盆用）；
//   · 个体差异（如"阳台里侧晒不到"）只属于这一盆，不改共享空间；
//   · 照片时间诚实（S7）：文件时间 ≠ 拍摄时间；明显旧照默认不作
//     当前状态；保存失败抛错提示，不静默丢图。
//   · 多张照片归同一盆；不做批量建档，避免照片归属混乱。
// ============================================================

import * as store from '../store.js';
import * as HM from '../home-model.js';
import { searchKnowledge, findKnowledge } from '../knowledge.js';
import { $, $$, esc, toast } from '../ui.js';
import { compressImage, photoTimeInfo } from '../services.js';
import { OBS_TAGS } from '../store.js';

/* 会话状态（进入页面时重置） */
let st;
function reset() {
  st = {
    photos: [],            // {dataUrl, timeInfo}
    pickedKey: null,       // 选中的知识条目
    manualName: '',
    pending: false,        // 暂存为待确认
    spaceId: 'none',       // 'none'=暂未设置，或已登记位置的 id
    micro: '',             // 个体差异（可选，只影响这一盆）
    obsTags: new Set(),
    asCurrent: true,
    searchQ: '',
    searchSeq: 0,          // 候选渲染序号：防抖+淘汰旧结果（v4 §1）
  };
}

export function render(root, args) {
  reset();
  draw(root);
}

function draw(root) {
  const home = HM.currentHome();
  const needsPick = HM.needsHomePick();
  const isaHome = home && !home.isExample;
  const spaces = isaHome ? store.listSpaces(home.id) : [];
  const picked = st.pickedKey ? findKnowledge(st.pickedKey) : null;
  const oldDetected = st.photos.some(p => p.timeInfo.old);

  /* 多家庭未选：不替用户挑（v3 §5），先去选择 */
  if (needsPick) {
    root.innerHTML = `
      <div class="empty" style="padding-top:60px"><div class="e-icon">家</div>
        <b>先选择"我的家"</b>
        <div class="mt8">检测到多个家庭：选一个继续，其余原样归档保留（不删任何数据）。</div>
        <a class="btn btn-primary mt14" href="#/spaces" style="display:inline-flex">去选择我的家</a>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="section-h"><h2>拍照建档</h2><span class="tiny">拍照 → 一次保存</span></div>
    <a class="card batch-entry" href="#/batch" style="display:block;text-decoration:none">
      <b>拍整屋照片，一次认出多盆 →</b>
      <div class="tiny mt8">几张照片自动找出每盆植物（识别服务开启后可用）；看不清或没拍到的，再回这里单独补一盆。</div>
    </a>
    ${!home ? `<div class="note note-plain mb8">第一盆植物保存时会自动建立「我的家」；城市可以之后再补（建议尽快：影响季节建议）。</div>` : ''}
    ${home && home.isExample ? `<div class="note note-plain mb8">目前只有示例家——这次保存会自动建立<b>你的家</b>（不会被示例的城市误导）；位置保存后再设。</div>` : ''}
    <div class="note note-warn mb8"><span class="badge-offline">照片识别未接入</span>
      身份用下面的手动选择完成，一次存好；接入识别后这里会自动预填这些内容。</div>

    <div class="card">
      <div class="field"><label>① 拍张照片</label>
        <label class="photo-add" for="a-cam">现场拍一张</label>
        <input type="file" id="a-cam" accept="image/*" capture="environment" hidden>
        <label class="photo-add" for="a-file" style="margin-top:10px">从相册选（可多张，都归这一盆）</label>
        <input type="file" id="a-file" accept="image/*" multiple hidden>
        ${st.photos.length ? `
          <div class="photo-thumbs">
            ${st.photos.map((p, i) => `
              <div class="th"><img src="${p.dataUrl}" alt="照片${i + 1}">
                <button class="del" data-i="${i}" aria-label="删除这张">✕</button></div>`).join('')}
          </div>
          <div class="tiny mt8">
            ${st.photos.map(p2 => {
              const t = p2.timeInfo;
              if (!t.known) return '· 有照片读不到文件时间——是不是刚拍的只有你知道，请按下面勾选处理';
              const d = t.days;
              return t.old
                ? `· 有照片按文件时间约 ${d} 天前——只当资料图，不按"今天的状态"出提醒`
                : `· 按文件时间约 ${d === 0 ? '今天' : d + ' 天前'}；注意：文件时间不等于实拍时间（转存会变新），不是近照就取消下面勾选`;
            }).join('<br>')}
          </div>
          <div class="row mt8"><span class="chip ${st.asCurrent ? 'on' : ''}" id="a-cur">照片代表植物当前的样子</span></div>
          <div class="tiny mt8">${oldDetected && !st.asCurrent
            ? '按旧照处理：下面的"变化"只进档案记录，不进本周提醒、不当作今天。'
            : '如果照片其实是旧照，请取消勾选，以你的记忆为准。'}</div>
        ` : '<div class="tiny mt8">不拍也能先存档案；但建议拍一张，以后家人都认得出是哪一盆。</div>'}
      </div>
    </div>

    <div class="card">
      <div class="field"><label>② 它是谁</label>
        <div class="search-bar" style="margin-bottom:10px">
          <input class="input" id="a-search" placeholder="搜常见名（如：绿萝 / 蝴蝶兰 / 多肉）" value="${esc(st.searchQ)}">
        </div>
        <div class="chip-row" id="a-cands"></div>
        <div class="field mt14"><label>或直接写名字（认不出就先留着）</label>
          <input class="input" id="a-name" value="${esc(st.manualName)}" placeholder="例如：朋友送的兰花">
        </div>
        <span class="chip ${st.pending ? 'on' : ''}" id="a-pending">先存为"待确认植物"</span>
        <div class="tiny mt8">${picked
          ? `已按「${esc(picked.name)}」准备建档（学名 ${esc(picked.sci)}；档案里可随时更正）`
          : st.pending || (!st.manualName && !st.pickedKey) ? '身份没把握没关系：先存"待确认"，以后在档案里说一句"这是XX"就能更新。'
          : `将按名字「${esc(st.manualName)}」记录；如果它其实是常见植物，从上面选一个更合适。`}</div>
      </div>
    </div>

    <div class="card">
      <div class="field"><label>③ 放在哪个位置${isaHome ? '' : '（你的家还没建——这次先选"暂未设置"）'}</label>
        <div class="chip-row">
          <span class="chip ${st.spaceId === 'none' ? 'on' : ''}" data-sp="none">暂未设置</span>
          ${spaces.map(sp => `<span class="chip ${st.spaceId === sp.id ? 'on' : ''}" data-sp="${sp.id}">${esc(sp.name)}</span>`).join('')}
        </div>
        ${isaHome ? `
        <div class="row mt8">
          <input class="input grow" id="a-newspace" placeholder="或新建位置（名字即可，如：客厅窗边）">
          <button class="btn btn-s" id="a-mkspace">建位置</button>
        </div>
        <div class="tiny mt8">位置的光照/雨淋等环境在保存后到「摆放位置」里补一次、多盆共用，不用每盆重复填（T06）。</div>` : ''}
        <div class="field mt14"><label>这一盆的个体差异（可选，只影响这一盆）</label>
          <input class="input" id="a-micro" placeholder="如：放在阳台里侧，基本晒不到" value="${esc(st.micro)}">
        </div>
      </div>
    </div>

    <div class="card">
      <div class="field"><label>④ 照片里有变化吗（可多选）</label>
        <div class="chip-row">
          ${Object.entries(OBS_TAGS).map(([tag, label]) => `<span class="chip ${st.obsTags.has(tag) ? 'on' : ''}" data-o="${tag}">${esc(label)}</span>`).join('')}
        </div>
        <div class="tiny mt8">观察只是记录变化，应用不据此排日程；照片按旧照处理时也不当作今天。</div>
      </div>
    </div>

    <button class="btn btn-primary btn-block" id="a-save">保存这盆植物</button>
    <div class="center tiny mt8">保存后马上能看到它的档案、浇水判断与五行小卡（待确认的除小卡外也能看）。</div>
  `;

  bind(root, isaHome);
}

function bind(root, isaHome) {
  /* 照片 */
  [$('#a-cam', root), $('#a-file', root)].forEach(inp => inp.addEventListener('change', async e => {
    await addPhotos([...e.target.files]);
    e.target.value = '';
    draw(root);
  }));
  $$('.photo-thumbs .del', root).forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    st.photos.splice(+b.dataset.i, 1);
    draw(root);
  }));
  const cur = $('#a-cur', root);
  if (cur) cur.addEventListener('click', () => { st.asCurrent = !st.asCurrent; draw(root); });

  /* 身份 —— v4 §1 修复：候选区局部更新。输入节点从不重建，焦点与光标保持稳定；
     中文输入法组合期间不刷新候选（不打断候选词），compositionend 再检索；
     防抖 120ms + 序号淘汰，旧结果不会覆盖最新输入。 */
  const search = $('#a-search', root);
  const candBox = $('#a-cands', root);
  let composing = false, debT = null;
  const candsHTML = () => {
    const q = (st.searchQ || '').trim();
    const cands = (q ? searchKnowledge(q) : searchKnowledge('')).slice(0, 12);
    return cands.map(k => `<span class="chip ${st.pickedKey === k.key ? 'on' : ''}" data-k="${k.key}">${esc(k.name)}</span>`).join('');
  };
  const renderCands = () => { if (candBox) candBox.innerHTML = candsHTML(); };
  const scheduleCands = () => {
    const seq = ++st.searchSeq;
    if (debT) clearTimeout(debT);
    debT = setTimeout(() => { if (seq === st.searchSeq) renderCands(); }, 120);
  };
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; st.searchQ = search.value; scheduleCands(); });
  search.addEventListener('input', e => {
    st.searchQ = search.value;               // 状态跟随输入（结构性重绘后可恢复）
    if (e.isComposing || composing) return;   // 拼音组合期间只记不刷新，绝不打断
    scheduleCands();
  });
  candBox.addEventListener('click', e => {     // 候选委托：局部重建无需重复绑定
    const c = e.target.closest('[data-k]');
    if (!c) return;
    if (st.pickedKey === c.dataset.k) st.pickedKey = null;
    else { st.pickedKey = c.dataset.k; st.manualName = ''; st.pending = false; }
    draw(root);                                // 选择动作是结构性变化，此时重绘合理
  });
  renderCands();                               // 初始候选一次（后续由局部渲染维护）
  const name = $('#a-name', root);
  name.addEventListener('input', () => { st.manualName = name.value; st.pickedKey = null; st.pending = st.pending && !name.value; renderCands(); });
  $('#a-pending', root).addEventListener('click', () => {
    st.pending = !st.pending;
    if (st.pending) { st.manualName = ''; st.pickedKey = null; }
    draw(root);
  });

  /* 位置（T06）与个体差异 */
  $$('[data-sp]', root).forEach(c => c.addEventListener('click', () => { st.spaceId = c.dataset.sp; draw(root); }));
  const mk = $('#a-mkspace', root);
  if (mk) mk.addEventListener('click', () => {
    const nm = $('#a-newspace', root).value.trim();
    if (!nm) return toast('位置名字写几个字');
    const sp = store.addSpace({ homeId: HM.currentHome().id, name: nm });
    st.spaceId = sp.id;
    toast(`已建位置「${nm}」；环境到「摆放位置」里补`);
    draw(root);
  });
  const micro = $('#a-micro', root);
  if (micro) micro.addEventListener('input', () => { st.micro = micro.value; });

  /* 观察 */
  $$('[data-o]', root).forEach(c => c.addEventListener('click', () => {
    const t = c.dataset.o;
    st.obsTags.has(t) ? st.obsTags.delete(t) : st.obsTags.add(t);
    draw(root);
  }));

  /* 保存 */
  $('#a-save', root).addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (btn.disabled) return;              // 防双击重复建档（T16）
    btn.disabled = true; btn.textContent = '保存中…';
    try { await doSave(root); }            // 失败自动恢复按钮（可修正后重试，不会重复建）
    finally { btn.disabled = false; btn.textContent = '保存这盆植物'; draw(root); }
  });
  async function doSave(root) {
    if (!st.photos.length && !st.pending && !st.pickedKey && !st.manualName) {
      toast('至少拍一张照片，或填上它的名字');
      return;
    }
    const home = HM.ensureHome();
    if (!home) { toast('先选择"我的家"再保存（数据不会乱）'); location.hash = '#/spaces'; return; }

    /* 身份判定 */
    let knowledgeKey = null, identityPending = st.pending, name = st.manualName.trim();
    if (st.pickedKey) {
      knowledgeKey = st.pickedKey;
      name = findKnowledge(knowledgeKey).name;
      identityPending = false;
    } else if (name && !identityPending) {
      const hit = searchKnowledge(name).find(k => k.name === name || k.aliases.some(a => a === name));
      if (hit) { knowledgeKey = hit.key; name = hit.name; }
    }
    if (!name && identityPending) name = '待确认植物';

    /* 位置重绑：只接受属于目标家的位置（示例家→新家切换时悬空位置置空） */
    let spaceId = st.spaceId;
    if (spaceId && spaceId !== 'none') {
      const sp = store.getSpace(spaceId);
      if (!sp || sp.homeId !== home.id) spaceId = 'none';
    }

    const plant = store.addPlant({
      familyId: home.id,
      spaceId: spaceId === 'none' ? null : spaceId,
      micro: st.micro.trim(),
      name,
      knowledgeKey,
      identity: knowledgeKey
        ? { cnName: name, sciName: findKnowledge(knowledgeKey)?.sci || '', source: 'knowledge' }
        : identityPending ? { cnName: name, sciName: '', source: 'pending' } : { cnName: name, sciName: '', source: 'manual' },
      identityPending,
    });
    if (!plant) {
      /* v4 §6.A：写入失败不发布假成功。草稿（照片/名字/位置）都还在页面上，
         用户清理空间或导出备份后可原样重点保存，不会重复建错。 */
      toast('本机存储写入失败：这盆还没真正存入。你填的内容都还在，可在「设置」导出备份、清理空间后再点一次保存。');
      return;
    }

    /* 照片：压缩后分层保存；失败可见（不静默丢图） */
    let firstPhotoId = null, photoFail = 0;
    for (const p of st.photos) {
      try {
        const ph = await store.savePhoto(p.dataUrl, { capturedAt: p.timeInfo.ts, oldPhoto: p.timeInfo.old });
        plant.photoIds.push(ph.id);
        if (!firstPhotoId) firstPhotoId = ph.id;
      } catch (e) { photoFail++; }
    }

    /* 观察变化（非流水；旧照不作当前状态） */
    if (st.obsTags.size) {
      const oldDetected = st.photos.some(p => p.timeInfo.old);
      store.addObservation({
        plantId: plant.id,
        tags: [...st.obsTags],
        text: st.photos.length ? '建档时从照片看到' : '建档时记录',
        source: 'user',
        photoId: firstPhotoId,
        isCurrentState: st.asCurrent && !oldDetected,
      });
    }

    if (!store.save()) toast('档案已存，但写入本机存储失败（可能空间不足）——请到设置里导出备份并清理。');
    if (photoFail) toast(`有 ${photoFail} 张照片没能保存（本机空间不足）；植物档案已建立，可稍后在档案里补拍。`);
    toast('已建档');
    location.hash = `#/plant/${plant.id}`;
  }
}

async function addPhotos(files) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast('有一张照片太大，换一张吧'); continue; }
    try {
      const dataUrl = await compressImage(f);
      st.photos.push({ dataUrl, timeInfo: photoTimeInfo(f) });
    } catch (e) { console.warn(e); toast('有一张照片读取失败'); }
  }
  if (st.photos.some(p => p.timeInfo.old)) st.asCurrent = false;
  // v4 §6.E：读不到文件时间的照片不默认当作"当前的样子"——勾选与否由你定，
  // 核实责任不悄悄推回给默认值。
  else if (st.photos.some(p => !p.timeInfo.known)) st.asCurrent = false;
}
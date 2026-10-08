// ============================================================
// views/spaces.js — 我的摆放位置（v3 §4 / §5）
//
// 单家庭模式的位置管理页（覆盖式子页 #/spaces）：
//   · 顶部：家与城市（一次设置；定位候选制、坐标不保存）
//   · 位置列表：名称 + 少量环境标签（全部可选，未勾如实显示"未知"）
//   · 新建/编辑/删除位置；删除只把植物移入「暂未设置」，不删植物
//   · 检测到 ≥2 个真实家庭时：先渲染"选我的家"迁移面板
//     （其余家庭归档保留、可导出找回，绝不删除数据）
//
// 红线（v3 §4.4）：
//   · 位置名称（阳台/走廊）不代表光照与通风——只有勾选的
//     信息才算登记；全部未勾就如实显示"环境未补充"。
//   · "靠窗"是用户声明的事实；"有窗=常通风"不成立 → 空气流动
//     单独登记（常开窗/很少开窗/有风口），不互相替代。
// ============================================================

import * as store from '../store.js';
import * as weather from '../weather.js';   // v4 §5：和风城市/天气（经代理、密钥不进浏览器）
import * as HM from '../home-model.js';
import { REGIONS, findCity, nearestCities, zoneDesc } from '../knowledge.js';
import { $, $$, esc, toast, confirmDlg, openSheet } from '../ui.js';
import { getLocation } from '../services.js';

const EXPOSURE = ['未知', '室内', '半室外', '室外'];
const LIGHT = ['', '靠窗', '明亮散光', '有直射光', '全日照', '无直射光', '阴影处'];
const AIR = ['', '常开窗', '很少开窗', '有风口'];
const RAIN = ['未知', '基本不淋雨', '会淋雨'];
const LIGHT_LABEL = { '': '未补充', };

/* ---------------- 主体 ---------------- */

export function render(sub, args) {
  draw(sub);
}

function draw(sub) {
  // ≥2 真实家庭：先选家（迁移面板；绝不擅自决定）
  if (HM.needsHomePick()) { renderHomePick(sub); return; }

  const home = HM.currentHome();
  if (!home) {
    sub.innerHTML = `
      <div class="subpage-inner" style="padding-top:80px">
        <div class="empty"><div class="e-icon">家</div>
          还没有"我的家"。先去「建档」存第一盆植物，家会自动建立；<br>之后再回来设置城市与位置。</div>
      </div>`;
    return;
  }

  const spaces = store.listSpaces(home.id);
  const isa = !!home.isExample;

  sub.innerHTML = `
    <div class="subpage-inner">
      <div class="topbar">
        <button class="back" id="sp-back" aria-label="返回">‹</button>
        <div class="title">摆放位置</div>
        <div class="spacer"></div>
      </div>

      ${isa ? `<div class="note note-warn mb8">当前是<b>示例家庭</b>（${esc(home.city?.name || '')}）。你建档第一盆植物时会自动建立真实的「我的家」，示例不会被当作你的城市。</div>` : ''}

      <div class="card">
        <div class="plant-tile">
          <div class="thumb thumb-ph" style="background:var(--c-primary-soft);color:var(--c-primary-deep)">家</div>
          <div class="pt-body">
            <div class="pt-name">${esc(home.name)}${isa ? '<span class="badge-pending">示例</span>' : ''}</div>
            <div class="sub">${home.city
              ? esc(home.city.name) + ' · ' + esc(home.city.province) + `<span class="tiny">（${esc(home.city.zone)}：${esc(zoneDesc(home.city.zone))}）</span>`
              : '还没设置城市'}</div>
            <div class="tiny mt8">${home.city ? '城市决定季节背景；与手机当前位置无关，只有你在这里手动确认才会改。' : '设置后，浇水参考间隔与季节提醒会按城市给出。'}</div>
          </div>
        </div>
        <button class="btn btn-s mt8" id="sp-city">${home.city ? '修改城市' : '设置城市'}</button>
      </div>

      <div class="section-h"><h2>摆放位置</h2><span class="tiny">建一次 · 多盆复用</span></div>
      <div class="note note-plain mb8">位置就是"一段名字 + 几个可选点"，不是问卷。名字本身不代表环境——阳台不一定晒、走廊不一定通风；勾过的才算，没勾如实显示未知。每盆还可以有个体差异（如"放在里侧阴影处"），在植物档案里补。</div>

      ${spaces.length ? spaces.map(spaceCardHTML).join('') : `
        <div class="empty"><div class="e-icon">位</div>还没有位置。下面新建一个，名字几个字就行（比如"客厅窗边"）。</div>`}

      <button class="btn btn-primary btn-block mt8" id="sp-new">＋ 新建位置</button>
      <div class="tiny mt8 center">建档时也能当场新建位置；不确定的植物可以先放「暂未设置」。</div>
    </div>`;

  $('#sp-back', sub).addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/home';
  });
  $('#sp-city', sub).addEventListener('click', () => citySheet(home, sub));
  $('#sp-new', sub).addEventListener('click', () => spaceSheet(null, home, sub));
  $$('[data-edit]', sub).forEach(b => b.addEventListener('click', () => spaceSheet(store.getSpace(b.dataset.edit), home, sub)));
  $$('[data-del]', sub).forEach(b => b.addEventListener('click', () => deleteFlow(store.getSpace(b.dataset.del), sub)));
}

/* ---------------- 位置卡片 ---------------- */

function envTagsHTML(sp) {
  const tags = [];
  if (sp.exposure && sp.exposure !== '未知') tags.push(sp.exposure);
  if (sp.light) tags.push(sp.light);
  if (sp.air) tags.push(sp.air);
  if (sp.rain && sp.rain !== '未知') tags.push(sp.rain);
  if (!tags.length) return '<span class="tiny">环境未补充——名字不算环境，不确定就先这样用</span>';
  return tags.map(t => `<span class="chip" style="min-height:32px">${esc(t)}</span>`).join('');
}

function spaceCardHTML(sp) {
  const n = store.spacePlantCount(sp.id);
  return `
    <div class="card">
      <div class="plant-tile">
        <div class="thumb thumb-ph" style="background:var(--c-primary-soft);color:var(--c-primary-deep)">位</div>
        <div class="pt-body">
          <div class="pt-name">${esc(sp.name)}</div>
          <div class="chip-row mt8">${envTagsHTML(sp)}</div>
          ${sp.note ? `<div class="tiny mt8">备注：${esc(sp.note)}</div>` : ''}
          <div class="tiny mt8">${n} 盆植物在这里</div>
        </div>
      </div>
      <div class="gap-btns">
        <button class="btn btn-s" data-edit="${sp.id}">编辑</button>
        <button class="btn btn-danger-outline btn-s" data-del="${sp.id}">删除位置</button>
      </div>
    </div>`;
}

/* ---------------- 新建/编辑位置 ---------------- */

function spaceSheet(sp, home, sub) {
  const isNew = !sp;
  const cur = sp || {};
  const sel = { exposure: cur.exposure || '未知', light: cur.light || '', air: cur.air || '', rain: cur.rain || '未知' };

  const sheet = openSheet(`
    <h3>${isNew ? '新建位置' : '编辑「' + esc(cur.name) + '」'}</h3>
    <div class="sub">${isNew ? '名字几个字就行；环境点全部可选，不确定就不勾，以后再补。' : '改动只影响这一个位置下共享的环境；每盆个体的差异去植物档案里补。'}</div>
    <div class="field"><label>位置名称（可重名，如同为"阳台"的封闭与露天）</label>
      <input class="input" id="ss-name" value="${esc(cur.name || '')}" placeholder="如：客厅窗边 / 南阳台"></div>
    <div class="field"><label>在室内还是室外</label>
      <div class="chip-row" id="ss-exposure">${EXPOSURE.map(v => `<span class="chip ${sel.exposure === v ? 'on' : ''}" data-v="${v}">${v === '未知' ? '不确定' : v}</span>`).join('')}</div></div>
    <div class="field"><label>光照（选一个最像的；没有合适的先不选）</label>
      <div class="chip-row" id="ss-light">${LIGHT.map(v => `<span class="chip ${sel.light === v ? 'on' : ''}" data-v="${v}">${v || '未补充'}</span>`).join('')}</div></div>
    <div class="field"><label>开窗/风口（"有窗"不等于常通风——照实选）</label>
      <div class="chip-row" id="ss-air">${AIR.map(v => `<span class="chip ${sel.air === v ? 'on' : ''}" data-v="${v}">${v || '未补充'}</span>`).join('')}</div></div>
    <div class="field"><label>下雨天会不会淋到</label>
      <div class="chip-row" id="ss-rain">${RAIN.map(v => `<span class="chip ${sel.rain === v ? 'on' : ''}" data-v="${v}">${v === '未知' ? '不确定' : v}</span>`).join('')}</div></div>
    <div class="field"><label>补充说明（一句话，如"封闭阳台，冬天不开窗"）</label>
      <textarea class="textarea" id="ss-note" placeholder="可选">${esc(cur.note || '')}</textarea></div>
    <button class="btn btn-primary btn-block" id="ss-save">${isNew ? '创建位置' : '保存修改'}</button>
  `);

  const bindSingle = (boxId, key, all) => {
    $$(`#${boxId} .chip`, sheet.root).forEach(c => c.addEventListener('click', () => {
      sel[key] = c.dataset.v;
      $$(`#${boxId} .chip`, sheet.root).forEach(x => x.classList.toggle('on', x.dataset.v === sel[key]));
    }));
  };
  bindSingle('ss-exposure', 'exposure');
  bindSingle('ss-light', 'light');
  bindSingle('ss-air', 'air');
  bindSingle('ss-rain', 'rain');

  $('#ss-save', sheet.root).addEventListener('click', () => {
    const name = $('#ss-name', sheet.root).value.trim();
    const note = $('#ss-note', sheet.root).value.trim();
    if (!name) return toast('给位置起个名字（几个字就行）');
    const fields = { name, exposure: sel.exposure, light: sel.light, air: sel.air, rain: sel.rain, note };
    if (isNew) store.addSpace({ homeId: home.id, ...fields });
    else store.updateSpace(sp.id, fields);
    sheet.close();
    toast(isNew ? `已创建「${name}」` : `已更新「${name}」`);
    draw(sub);
  });
}

/* ---------------- 删除位置 ---------------- */

async function deleteFlow(sp, sub) {
  if (!sp) return;
  const n = store.spacePlantCount(sp.id);
  const ok = await confirmDlg({
    title: `删除「${esc(sp.name)}」？`,
    danger: true, okText: '删除位置',
    body: `这里的 <b>${n} 盆植物</b>将移入「暂未设置」，<b>不会被删除</b>，档案、照片都保留；其他位置不受影响。`,
  });
  if (!ok) return;
  const r = await store.deleteSpace(sp.id);
  toast(`已删除位置；${r.moved} 盆植物移入「暂未设置」`);
  draw(sub);
}

/* ---------------- 城市设置（定位候选/手动省市；坐标不保存） ---------------- */

function mountCityPicker(root, initial) {
  let city = initial ? { ...initial } : null;

  /* v4 §5：和风城市搜索（真实 GeoAPI，经代理）。未配置/不可达时
     降级内置省市表并如实说明原因——城市代表坐标（qw）随选择保存。 */
  const sOut = $('#f-search-out', root);
  const doSearch = async () => {
    const q = ($('#f-q', root).value || '').trim();
    if (!q) return;
    sOut.innerHTML = '<div class="tiny mt8">搜索中…</div>';
    const r = await weather.searchCity(q);
    if (r.status === 'ok' && r.candidates.length) {
      sOut.innerHTML = `<div class="chip-row mt8" id="f-res">${r.candidates.map((c, i) => `<span class="chip" data-i="${i}">${esc(c.name)}（${esc(c.adm || c.adm1)}）</span>`).join('')}</div>`;
      $$('#f-res .chip', sOut).forEach(ch => ch.addEventListener('click', () => {
        const c = r.candidates[+ch.dataset.i];
        const builtin = findCity(c.adm1 || '', c.name);
        city = {
          name: c.name, province: c.adm1 || (builtin ? builtin.province : ''),
          zone: builtin ? builtin.zone : '',
          qw: { id: c.id, lat: c.lat, lon: c.lon },      // 和风城市代表坐标（不是你的定位）
        };
        const ps = $('#f-prov', root);
        if (ps) ps.value = c.adm1 || '';
        sOut.innerHTML = `<div class="tiny">已确认：${esc(c.name)}${c.adm ? '（' + esc(c.adm) + '）' : ''}——用和风返回的城市代表坐标（${Number(c.lat).toFixed(2)}, ${Number(c.lon).toFixed(2)}）取当地天气。</div>`;
      }));
    } else if (r.status === 'error' && (r.error === 'qweather-unconfigured' || r.error === 'unreachable' || r.error === 'timeout')) {
      sOut.innerHTML = `<div class="tiny">和风暂不可用（${esc(r.error === 'qweather-unconfigured' ? '未配置凭证' : r.error)}）——用下面的内置省市表选，季节建议照常；天气要等凭证配好并重选一次城市后才有。</div>`;
    } else {
      sOut.innerHTML = `<div class="tiny">没搜到「${esc(q)}」——换个词，或在下面选省份。</div>`;
    }
  };
  const sBtn = $('#f-search', root);
  if (sBtn) sBtn.addEventListener('click', doSearch);
  const qEl = $('#f-q', root);
  if (qEl) qEl.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  const provSel = $('#f-prov', root);
  provSel.innerHTML = `<option value="">选择省份</option>` +
    REGIONS.map(r => `<option value="${esc(r.p)}"${initial && initial.province === r.p ? ' selected' : ''}>${esc(r.p)}</option>`).join('');

  const drawCities = p => {
    const box = $('#f-city', root);
    const r = REGIONS.find(x => x.p === p);
    if (!r) { box.innerHTML = '<span class="tiny">选省份后选城市</span>'; return; }
    box.innerHTML = r.c.map(([n]) => `<span class="chip ${city && city.name === n ? 'on' : ''}" data-n="${esc(n)}">${esc(n)}</span>`).join('');
    $$('[data-n]', box).forEach(c => c.addEventListener('click', () => {
      city = findCity(p, c.dataset.n);
      if (city && city.lat !== undefined) city.qw = { lat: city.lat, lon: city.lng };   // 内置坐标也足以取实况/预报
      drawCities(p);
    }));
  };
  provSel.addEventListener('change', () => { city = null; drawCities(provSel.value); });
  drawCities(initial ? initial.province : '');

  const geoOut = $('#f-geo-out', root);
  $('#f-geo', root).addEventListener('click', async () => {
    const btn = $('#f-geo', root);
    btn.textContent = '定位中…';
    const loc = await getLocation();
    btn.textContent = '定位选城市（需授权，坐标不保存）';
    if (!loc.ok) {
      geoOut.innerHTML = `<div class="tiny" style="color:var(--c-warn)">${esc(loc.error)}——直接手动选也一样。</div>`;
      return;
    }
    // v4 §5：优先和风反查（真实城市库，经代理）；不可用降级内置就近表
    const wr = await weather.lookupByCoords(loc.lat, loc.lng);
    const pick = (c) => {
      const builtin = findCity(c.province || c.adm1 || '', c.name);
      city = {
        name: c.name, province: c.province || c.adm1 || (builtin ? builtin.province : ''),
        zone: builtin ? builtin.zone : '',
        qw: (c.lat !== null && c.lon !== null) ? { id: c.id || null, lat: c.lat, lon: c.lon } : (builtin && builtin.lat !== undefined ? { lat: builtin.lat, lon: builtin.lng } : null),
      };
      provSel.value = city.province;
      geoOut.innerHTML = city.qw
        ? `<div class="tiny">已确认：${esc(city.name)}——用${c.id ? '和风返回的城市代表坐标' : '内置城市坐标'}取天气；你的定位坐标只用于这次反查，不保存。</div>`
        : `<div class="tiny">已确认：${esc(city.name)}。这个城市暂没有天气坐标——配置和风后用搜索重选一次即有。</div>`;
      drawCities(city.province);
    };
    if (wr.status === 'ok' && wr.candidates.length) {
      geoOut.innerHTML = `<div class="tiny mt8">和风按你的定位给出候选（只用于这次反查，不保存）：</div>
        <div class="chip-row mt8" id="f-cands">${wr.candidates.map((c, i) => `<span class="chip" data-i="${i}">${esc(c.name)}（${esc(c.adm || c.adm1)}）</span>`).join('')}</div>`;
      $$('#f-cands .chip', geoOut).forEach(ch => ch.addEventListener('click', () => pick(wr.candidates[+ch.dataset.i])));
    } else {
      const cands = nearestCities(loc.lng, loc.lat, 3);
      geoOut.innerHTML = `
        <div class="tiny mt8">和风反查暂不可用——用内置表就近给出候选。</div>
        <div class="chip-row mt8" id="f-cands">${cands.map((c, i) => `<span class="chip" data-i="${i}">${esc(c.name)}（${esc(c.province)}）</span>`).join('')}</div>`;
      $$('#f-cands .chip', geoOut).forEach(ch => ch.addEventListener('click', () => pick(cands[+ch.dataset.i])));
    }
  });
  return () => city;
}

function citySheet(home, sub) {
  const sheet = openSheet(`
    <h3>${home.city ? '修改' : '设置'}城市</h3>
    <div class="sub">城市只设一次、只在这里能改；不会跟着手机定位自动变化。修改后该城市对应的季节背景更新。</div>
    <div class="row mt8">
      <input class="input grow" id="f-q" placeholder="直接搜城市名（如：杭州 / 西湖区）">
      <button class="btn btn-s" id="f-search">搜</button>
    </div>
    <div id="f-search-out"></div>
    <button class="btn btn-s mt8" id="f-geo">定位选城市（需授权，坐标不保存）</button>
    <div id="f-geo-out"></div>
    <select class="select mt8" id="f-prov"></select>
    <div class="chip-row mt8" id="f-city"></div>
    <button class="btn btn-primary btn-block mt14" id="f-save">保存城市</button>
  `);
  const getCity = mountCityPicker(sheet.root, home.city || null);
  $('#f-save', sheet.root).addEventListener('click', async () => {
    const city = getCity();
    if (!city) return toast('先定位确认或手动选一个城市');
    if (home.city && city.name === home.city.name) { sheet.close(); return; }
    if (home.city) {
      const ok = await confirmDlg({
        title: '确认修改城市？',
        body: `城市将从 <b>${esc(home.city.name)}</b> 改为 <b>${esc(city.name)}</b>。全部植物的季节建议随之调整；档案、照片与位置不变。`,
      });
      if (!ok) return;
    }
    store.updateFamily(home.id, { city });
    sheet.close();
    toast(`城市已设置：${city.name}`);
    draw(sub);
  });
}

/* ---------------- 多真实家庭：选我的家（一次性迁移面板） ---------------- */

function renderHomePick(sub) {
  const cands = HM.homePickCandidates();
  const archived = HM.archivedRealFamilies().length;
  sub.innerHTML = `
    <div class="subpage-inner">
      <div class="topbar">
        <button class="back" id="hp-back" aria-label="返回">‹</button>
        <div class="title">选我的家</div>
        <div class="spacer"></div>
      </div>
      <div class="note note-warn mb8">检测到 <b>${cands.length} 个家庭</b>。植伴现在按"一个家"工作：选一个继续用；
        其余原样<b>归档保留</b>（不显示、不删除，可在设置页导出备份找回）。植物、照片、位置都不会丢。</div>
      ${cands.map(c => `
        <div class="card">
          <div class="plant-tile">
            <div class="thumb thumb-ph" style="background:var(--c-primary-soft);color:var(--c-primary-deep)">家</div>
            <div class="pt-body">
              <div class="pt-name">${esc(c.name)}</div>
              <div class="sub">${esc(c.city || '未设城市')} · ${c.plants} 盆植物</div>
            </div>
          </div>
          <button class="btn btn-primary btn-block mt8" data-pick="${c.id}">就用这个家</button>
        </div>`).join('')}
      <div class="tiny center mt8">选择后立即生效；迁移前会自动生成一次性备份。</div>
    </div>`;
  $('#hp-back', sub).addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/home';
  });
  $$('[data-pick]', sub).forEach(b => b.addEventListener('click', () => {
    const r = HM.pickHomeAndArchive(b.dataset.pick);
    toast(r.msg);
    if (r.ok) draw(sub);
  }));
}
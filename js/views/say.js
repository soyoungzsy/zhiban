// ============================================================
// views/say.js — 档案页「说一说」
//
// 用途：用一句日常话补充或更正档案（文档级信息，不是打卡）。
// 原则：
//   · 语音仅文字入站方式之一；权限被拒/设备不支持时文字输入完整可用；
//   · 「语音语义整理」为内置规则（示例级），界面如实标注；
//   · 只展示本次改变的字段（diff），不重复展示整份档案；
//   · 保留不确定语气："好像有花苞" ≠ "已进入花期"；
//   · 用户明确提供的信息优先于照片推测；
//   · 口语里提到的"昨天浇过"不会生成浇水记录或倒计时。
// ============================================================

import * as store from '../store.js';
import { searchKnowledge, findKnowledge } from '../knowledge.js';
import { $, $$, esc, toast } from '../ui.js';
import { speechSupported, listenSpeech } from '../services.js';

let s;
function reset() {
  s = { rec: null, recOn: false, changes: null, applied: null };
}

export function render(sub, args) {
  reset();
  const plant = store.getPlant(args[0]);
  if (!plant) {
    sub.innerHTML = `<div class="subpage-inner" style="padding-top:80px">
      <div class="empty">没有找到这盆植物。<br><a class="btn btn-primary mt14" style="display:inline-flex" href="#/home">回到首页</a></div></div>`;
    return;
  }
  draw(sub, plant);
}

/* ---------------- 规则解析（标注：内置规则示例级） ---------------- */

const softWords = /好像|可能|似乎|感觉|大概|应该|像是|有点/;

const OBS_RULES = [
  { re: /花苞|花骨朵|骨朵/, tag: 'bud', label: '花苞' },
  { re: /开花|开完花/, tag: 'flower', label: '开花' },
  { re: /黄叶|叶子黄|发黄|黄了/, tag: 'yellow-leaf', label: '黄叶' },
  { re: /斑点|黑斑|长斑|烂斑/, tag: 'spot', label: '斑点' },
  { re: /蚜虫|介壳虫|红蜘蛛|小虫|虫子|长虫/, tag: 'pest', label: '小虫' },
  { re: /新芽|新叶|冒芽|抽新/, tag: 'new-shoot', label: '新芽新叶' },
  { re: /打蔫|蔫了|垂下来|耷拉/, tag: 'wilt', label: '打蔫' },
  { re: /掉叶|落叶|掉花苞|掉苞/, tag: 'drop', label: '落叶掉苞' },
  { re: /徒长|越长越细|窜高/, tag: 'leggy', label: '徒长' },
  { re: /长势变差|越长越小|越长越稀|整盆没精神/, tag: 'weak', label: '长势变差' },
];

export function parseSay(text, plant) {
  const changes = [];
  const soft = softWords.test(text);


  /* 1) 家庭归属（v3 §5 单家庭版：不再迁移；检测到归属话术只给说明） */
  const fm = text.match(/(?:其实)?(?:在|搬(?:到|去)|放(?:在|到)|归|属于)([^，。,、\s]{1,5})家/);
  if (fm) {
    changes.push({
      type: 'home-info', label: '家庭归属（说明，不改数据）',
      from: '—', to: '植伴现在按"一个家"使用——这句话不改动归属；如有其他家的历史数据，已归档保留，可在设置页导出找回',
      apply: () => {},
    });
  }

  /* 2a) 名字更正："这不是绿萝，是玉树"
     v3 防误伤（T15）："不是露天阳台，是封闭的"是空间描述，不当植物名 */
  const ENV_WORDS = /(阳台|窗台|窗边|走廊|客厅|卧室|餐厅|厨房|卫生间|玄关|书房|封闭|露天|室内|室外|开窗|淋雨|直射|半阴|避雨)/;
  let nm = text.match(/不是([^，。,、\s]{1,8}?)[，,、\s]*(?:其实)?是([^，。,\s]{1,8})/);
  if (nm && ENV_WORDS.test(nm[1] + nm[2])) nm = null;   // 交给 4b 空间更正
  /* 2b) 直接报名："这是绿萝" / "其实是蝴蝶兰" */
  let dm = (!nm && !fm) ? text.match(/(?:这(?:盆|个|颗)?(?:其实)?(?:就)?是|它(?:其实)?是|叫)((?:一盆)?[\u4e00-\u9fa5]{1,8})/) : null;
  if (dm && ENV_WORDS.test(dm[1])) dm = null;          // "这是封闭阳台" → 不是改名

  let nameFixTarget = null, nameFixWrong = null;
  if (nm) { nameFixWrong = nm[1]; nameFixTarget = nm[2].trim(); }
  else if (dm) nameFixTarget = dm[1].replace(/^一盆/, '').trim();

  if (nameFixTarget) {
    const hit = searchKnowledge(nameFixTarget).find(k =>
      k.name === nameFixTarget || k.name.includes(nameFixTarget) ||
      k.aliases.some(a => a === nameFixTarget || a.includes(nameFixTarget)));
    if (hit) {
      changes.push({
        type: 'identity', label: '品种身份',
        from: (nameFixWrong ? `不是「${nameFixWrong}」；` : '') + (plant.identity.cnName || plant.name || '未知'),
        to: hit.name + `（${hit.sci}）`,
        key: hit.key,
        apply: () => {
          store.updatePlant(plant.id, {
            name: hit.name, knowledgeKey: hit.key, identityPending: false,
            identity: { cnName: hit.name, sciName: hit.sci, source: 'knowledge' },
          });
        },
      });
    } else if (nm) {
      // v4 §6.D 修复：更正为知识库没有的物种 → 停用旧物种指南（不拿绿萝的
      // 卡片糊弄玉树），清 knowledgeKey、转为待确认身份，以后核验后再关联。
      changes.push({
        type: 'rename', label: '名称更正（这种植伴还不太认识，先按待确认养）', from: plant.name, to: nameFixTarget,
        apply: () => store.updatePlant(plant.id, {
          name: nameFixTarget, knowledgeKey: null, identityPending: true,
          identity: { cnName: nameFixTarget, sciName: '', source: 'manual' },
        }),
      });
    }
  }

  /* 3) 长期背景："冬天会开暖气/地暖/空调"（v4 §6.C 修复：否定语义如实记录，不再反转） */
  if (/暖气|地暖/.test(text) || (/空调/.test(text) && /冬天|夏天/.test(text))) {
    const heatAt = text.search(/暖气|地暖|空调/);
    const pre = text.slice(Math.max(0, heatAt - 3), heatAt);
    const negHeat = /(不开|没开|没用|没有|没装|不装)/.test(pre) || /(暖气|地暖|空调).{0,2}(不开|没开|不用)/.test(text);
    const isHeater = /暖气|地暖/.test(text);
    const noteText = negHeat
      ? (isHeater ? '冬天这里不开暖气（屋里温度随室外走，怕冷的植物冬天要留意防寒）。' : '这里基本不开空调。')
      : (isHeater ? '冬天这个位置会开暖气。' : '这个位置附近有空调。');
    const hasNote = plant.notes.some(n => n.text === noteText);
    if (!hasNote) {
      changes.push({
        type: 'note', label: '长期背景（备注）', from: '未记录', to: noteText,
        apply: () => store.addNote(plant.id, noteText, 'heating-or-ac'),
      });
    }
  }

  /* 4) 位置与空间（v3 T12/T15：意愿/临时/模糊/实际 四路分叉；挂空间档案 T06） */
  const isFuture = /(想|打算|准备|计划)(.{0,6})(搬|挪|移|换过去)|(明天|后天|过[一几两三]?天|下周|周末|之后|回头|以后)(.{0,10})(搬|挪|移|换)/.test(text);
  const isTempShot = /(拿到?|放)了?桌(上|边)|桌上拍|拍照(时|完).{0,10}(还是|再放|放回|搬回)|(临时|暂时)(放|摆)/.test(text);
  const isMultiPot = /(这|那|剩)(两|三|四|五|几|\d+)\s*盆|另一盆|其余|剩下的几?(盆|棵)|都(挪|搬|放)/.test(text);
  const pm = (!isFuture && !isTempShot && !isMultiPot)
    ? text.match(/(?:搬到?|挪到?|放在|摆到?|收进|搬回|挪回|放回)(阳台|窗台|窗边|走廊|客厅|卧室|餐厅|厨房|卫生间|玄关|书房)/)
    : null;

  if (isFuture) {
    changes.push({
      type: 'plan', label: '未来打算（不当作已发生）',
      from: '—', to: `记一条备注：你提过「${text.trim().slice(0, 36)}」——真搬了之后再说一声，我才会改位置`,
      apply: () => store.addNote(plant.id, '你提过的计划：' + text.trim(), 'plan'),
    });
  } else if (isTempShot) {
    changes.push({
      type: 'ignore-temp', label: '临时拍照位置（不改动档案）',
      from: '—', to: '听出你只是把它拿到桌上拍照——长期摆放位置保持不变',
      apply: () => { /* 特意不改（T12） */ },
    });
  } else if (isMultiPot) {
    changes.push({
      type: 'ambiguous', label: '指代不明确（不代改其他盆）',
      from: '—',
      to: `听起来说的是好几盆——这页只对应「${plant.nickname || plant.name}」，其他盆请到它们各自档案里说；对位置本身的描述我仍会整理（见下）`,
      apply: () => { /* 不批量误改（T15） */ },
    });
  } else if (pm) {
    const roomName = pm[1];
    const pool = store.listSpaces(plant.familyId);
    /* v4 §6.C：同名位置不默认选第一个——多个同名时给消歧说明，由用户区分 */
    const exact = pool.filter(x => x.name === roomName);
    let sp = null, spAmb = null;
    if (exact.length === 1) sp = exact[0];
    else if (exact.length > 1) spAmb = exact;
    else {
      const inc = pool.filter(x => x.name.includes(roomName) || roomName.includes(x.name));
      if (inc.length === 1) sp = inc[0];
      else if (inc.length > 1) spAmb = inc;
    }
    const curSpace = plant.spaceId ? store.getSpace(plant.spaceId) : null;
    const fromName = curSpace ? curSpace.name : (plant.env.position || '暂未设置');
    if (spAmb) {
      const envOf = x => [x.exposure !== '未知' ? x.exposure : '', x.light, x.rain !== '未知' ? x.rain : ''].filter(Boolean).join('·') || '环境未登记';
      changes.push({
        type: 'space-disambig',
        label: `叫「${roomName}」的位置有 ${spAmb.length} 个（不替你猜是哪个）`,
        from: fromName, to: spAmb.map(x => envOf(x)).join(' 与 ') + '——到「摆放位置」给其中一个改名区分，或明确说一次（如"搬到露天那个阳台"）我再挂',
        apply: () => { /* 特意不代改：同名歧义由用户消解（v4 §6.C） */ },
      });
    } else if (!sp || sp.id !== plant.spaceId) {
      changes.push({
        type: 'space', label: sp ? '摆放位置（挂到已登记位置）' : '摆放位置（新建共享位置）',
        from: fromName, to: sp ? sp.name : `${roomName}（先用名字建一条；环境到「摆放位置」补，不用每盆重复填）`,
        apply: () => {
          const target = sp || store.addSpace({ homeId: plant.familyId, name: roomName });
          store.updatePlant(plant.id, { spaceId: target.id });
        },
      });
    }
  }

  /* 4b) 空间环境口头更正（用户明确说的 > 一切推测；确认后才更新共用字段，T11。
     该段不受"多盆指向"抑制——描述的是位置本身，不指认哪盆。 */
  /* v4 §6.C 修复：未来意愿（"明天想搬到露天阳台"）描述的是目标位置——
     绝不拿来改当前共享空间的环境字段。 */
  const spNow = (!isFuture && plant.spaceId) ? store.getSpace(plant.spaceId) : null;
  if (spNow) {
    const fix = {}; const touched = [];
    if (/封闭|不开窗|很少开窗|冬天不开窗/.test(text)) {
      fix.air = '很少开窗'; touched.push('很少开窗');
      if (spNow.exposure === '室外') { fix.exposure = '室内'; touched.push('室内'); }
    }
    if (/淋不到|淋不着|不会淋雨|不淋雨|避雨|遮雨|有顶棚/.test(text)) { fix.rain = '基本不淋雨'; touched.push('基本不淋雨'); }
    else if (/露天|会淋雨|淋得到|淋得着/.test(text)) { fix.rain = '会淋雨'; touched.push('会淋雨'); }
    if (touched.length) {
      changes.push({
        type: 'space-env',
        label: `位置「${spNow.name}」的环境更正（共用信息：确认后惠及放在这里的每一盆）`,
        from: [spNow.exposure !== '未知' ? spNow.exposure : '', spNow.light || spNow.air, spNow.rain !== '未知' ? spNow.rain : ''].filter(Boolean).join(' · ') || '未记录',
        to: touched.join(' · '),
        apply: () => store.updateSpace(spNow.id, fix),
      });
    }
  }

  /* 5) 变化观察（保留不确定语气；整句原样保存，不改写）
     v4 §6.C 修复：否定（"没有黄叶/没虫子"）不记成变化；疑问与未来
     （"以后会开花吗"）不当正在发生——给可读说明，不建观察。 */
  const seen = new Set();
  const isQuestion = /(吗|么|呢)[？?]?\s*$|[？?]\s*$|什么时候|啥时候|多久/.test(text.trim());
  const isFutureRef = /(以后|将来|明年后年|回头|等它长大|总有一天)/.test(text);
  let negatedAny = false, futQAny = false;
  for (const r of OBS_RULES) {
    if (seen.has(r.tag)) continue;
    if (r.re.test(text)) {
      const at = text.search(r.re);
      const pre = text.slice(Math.max(0, at - 3), at);
      const negated = /(没有|没|不|无)/.test(pre) && !/(不太|不怎么|有点|不大)/.test(pre);
      if (negated) { negatedAny = true; continue; }        // 否定语境：不记成观察
      if (isQuestion || isFutureRef) { futQAny = true; continue; }  // 疑问/未来：不当正在发生
      seen.add(r.tag);
      changes.push({
        type: 'obs', label: `观察到：${r.label}${soft ? '（疑似，按你原话保留）' : ''}`,
        from: '—', to: '「' + text.trim() + '」',
        apply: () => store.addObservation({
          plantId: plant.id, tags: [r.tag], text: text.trim(),
          source: 'user', uncertain: soft,
        }),
      });
    }
  }
  if (negatedAny && !seen.size) {
    changes.push({
      type: 'neg-info', label: '说明：这些都是"没有"的情况', from: '—',
      to: '「' + text.trim() + '」——没发生的我不记成变化；只有你看到的"有"（黄了、蔫了、开花了）才会记录',
      apply: () => {},
    });
  }
  if (futQAny && !seen.size) {
    changes.push({
      type: 'future-question', label: '问句 / 还没发生（不当作观察）', from: '—',
      to: '「' + text.trim() + '」——这句不记成"正在变化"。花期预测眼下没接入，不瞎猜；真看到了就说"开花了"，我马上记录',
      apply: () => {},
    });
  }

  /* 6) 浇水相关的话：只解释、不建账本（v3 红线 + T15） */
  if (/浇了|浇过|淋了水|浇了水|水浇得多|多久没浇/.test(text)) {
    changes.push({
      type: 'water-info', label: '浇水相关（不生成记录）',
      from: '—', to: '这句话我只当此刻的背景信息——植伴不做浇水账本，不会推断"隔多久没浇"或下次浇水时间',
      apply: () => { /* 特意不记录：需求红线 */ },
    });
  }

  return changes;
}

/* ---------------- 主体 ---------------- */

function draw(sub, plant) {
  const fam = store.getFamily(plant.familyId);
  const canSpeech = speechSupported();

  sub.innerHTML = `
    <div class="subpage-inner">
      <div class="topbar">
        <button class="back" id="sy-back" aria-label="返回">‹</button>
        <div class="title">说一说 · ${esc(plant.nickname || plant.name)}</div>
        <div class="spacer"></div>
      </div>

      <div class="note note-warn mb8"><span class="badge-offline">语音整理为内置规则（示例级）</span>
        我按关键词把你的话整理成档案更新；没把握的字段会保留你原话的语气，绝不把"好像有花苞"当成"已进入花期"。</div>

      ${canSpeech ? `
        <div class="card mic-panel">
          <button class="mic-btn ${s.recOn ? 'rec' : ''}" id="sy-mic">
            <svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm-7 9a7 7 0 0 0 14 0h-2a5 5 0 0 1-10 0H5zm6 7v2h3v-2h-3z"/></svg>
            ${s.recOn ? '正在听…' : '开始说'}
          </button>
          <div class="tiny mt8">按一下开始，说完自动停；说错了直接在下面改字。</div>
        </div>` : `
        <div class="note mb8">当前浏览器不支持语音识别（或权限未开启）。下面用打字输入，功能完全一样。</div>`}

      <div class="card">
        <div class="field"><label>想说的话（用嘴巴的方式说，用手指的方式写）</label>
          <textarea class="textarea" id="sy-text" placeholder="比如：&#10;· 这盆其实在妈妈家&#10;· 这不是绿萝，是朋友送的玉树&#10;· 冬天这个房间会开暖气&#10;· 最近好像长了几个花苞">${esc(s.rawText || '')}</textarea>
        </div>
        <button class="btn btn-primary btn-block" id="sy-go">帮我整理一下</button>
        ${fam ? `<div class="tiny mt8 center">对象的解释：现在改的是「${esc(plant.nickname || plant.name)}」（${esc(fam.name)}）。</div>` : ''}
      </div>

      ${s.changes && s.changes.length ? `
        <div class="section-h"><h2>本次会改变的字段</h2><span class="tiny">只列变化，别的不动</span></div>
        <div class="card">
          ${s.changes.map((c, i) => `
            <div class="diff-item">
              <label style="display:flex;gap:10px;align-items:flex-start">
                <input type="checkbox" data-c="${i}" ${c.on === false ? '' : 'checked'} style="width:22px;height:22px;margin-top:4px">
                <div style="flex:1">
                  <b>${esc(c.label)}</b><br>
                  ${c.from && c.from !== '—' ? `<span class="diff-old">${esc(c.from)}</span>` : ''}
                  <span class="diff-new">${esc(c.to)}</span>
                </div>
              </label>
            </div>`).join('')}
          <button class="btn btn-primary btn-block mt14" id="sy-apply">按勾选更新档案</button>
          <div class="tiny mt8 center">提到"昨天浇过水"之类的话不会生成浇水记录——本应用不做浇水账本。</div>
        </div>` : ''}

      ${s.applied ? `
        <div class="note mt14">已更新 ${s.applied} 项。其它内容不变；以后打开首页就会带上这些新信息。</div>
        <div class="gap-btns">
          <button class="btn" id="sy-again">再补充一点</button>
          <button class="btn btn-primary" id="sy-done">回档案看看</button>
        </div>` : ''}
    </div>`;

  $('#sy-back', sub).addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/home';
  });

  const ta = $('#sy-text', sub);
  if (s.rawText) ta.value = s.rawText;
  ta.addEventListener('input', () => { s.rawText = ta.value; });

  const mic = $('#sy-mic', sub);
  if (mic) mic.addEventListener('click', () => {
    if (s.recOn && s.rec) { s.rec.stop(); s.recOn = false; draw(sub, plant); return; }
    s.rec = listenSpeech({
      onResult: t => { s.rawText = t; const x = $('#sy-text', sub); if (x) x.value = t; },
      onEnd: () => {
        s.recOn = false;
        const m = $('#sy-mic', sub);
        if (m) { m.classList.remove('rec'); m.lastChild.textContent = '开始说'; }
      },
      onError: e => { toast(e.message || '语音识别不可用，请用文字输入'); },
    });
    if (s.rec) { s.recOn = true; mic.classList.add('rec'); mic.lastChild.textContent = '正在听… 点停'; }
  });

  $('#sy-go', sub).addEventListener('click', () => {
    const text = (s.rawText || $('#sy-text', sub).value || '').trim();
    if (!text) { toast('先说或写一句，比如"这盆其实在妈妈家"'); return; }
    s.rawText = text;
    s.applied = null;
    s.changes = parseSay(text, plant);
    if (!s.changes.length) {
      toast('没听出要改什么。可以说：它在哪个家 / 它是什么 / 看到了什么变化');
    }
    draw(sub, plant);
  });

  if (s.changes) {
    $$('#sy-chk, input[type=checkbox]', sub).forEach(ch => ch.addEventListener('change', () => {
      const i = +ch.dataset.c;
      if (s.changes[i]) s.changes[i].on = ch.checked;
    }));
    $('#sy-apply', sub).addEventListener('click', () => {
      let n = 0;
      for (const c of s.changes) if (c.on !== false) { c.apply(); n++; }
      s.changes = null;
      s.applied = n;
      s.rawText = '';
      toast(n ? `已更新 ${n} 项` : '没有勾选任何改动');
      draw(sub, plant);
    });
  }

  if (s.applied) {
    $('#sy-again', sub)?.addEventListener('click', () => { s.applied = null; s.rawText = ''; s.changes = null; draw(sub, plant); });
    $('#sy-done', sub)?.addEventListener('click', () => { location.hash = `#/plant/${plant.id}`; });
  }
}
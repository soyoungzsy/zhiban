// ============================================================
// ui.js — 通用 UI 工具（查询、转义、Toast、确认弹层、日期）
// ============================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** HTML 转义，所有用户内容入模板前必须经过它 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
export function toast(msg, ms = 2400) {
  let t = document.getElementById('zhiban-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'zhiban-toast';
    document.body.appendChild(t);
  }
  t.className = 'toast';
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/**
 * 通用确认弹层（底部抽屉）
 * body 为调用方拼好的 HTML，其中用户输入的内容必须由调用方 esc() 转义
 */
export function confirmDlg({ title, body = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        ${body ? `<div class="sub">${body}</div>` : ''}
        <div class="gap-btns">
          <button class="btn" data-act="no">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger-outline' : 'btn-primary'}" data-act="yes">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = v => { mask.remove(); resolve(v); };
    mask.querySelector('[data-act="yes"]').addEventListener('click', () => done(true));
    mask.querySelector('[data-act="no"]').addEventListener('click', () => done(false));
    mask.addEventListener('click', e => { if (e.target === mask) done(false); });
  });
}

/** 打开底部抽屉，返回 { root, close }；点击遮罩即关闭（等同取消） */
export function openSheet(html) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(mask);
  const root = mask.querySelector('.sheet');
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  function close() { mask.remove(); }
  return { root, close };
}

/** 全屏覆盖层（用于大字小卡等），返回 { root, close } */
export function openFullMask(html) {
  const mask = document.createElement('div');
  mask.className = 'card-fullmask';
  mask.innerHTML = html;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  function close() { mask.remove(); }
  return { root: mask, close };
}
// ============================================================
// js/pwa.js — 主屏幕/离线/更新提示（由 main.js 引入）
//
// · 注册 Service Worker（仅在有 SW 的浏览器；不支持时静默跳过，应用照常）
// · 版本检查：发现新版本待命 → 顶部绿色横幅"点此更新"——只在用户
//   主动点击时切换并重载，绝不在编辑/批量识别中强制刷新
// · 首次已可用时，设置页可见"添加到手机主屏幕"指引（设置卡由 settings.js 渲染）
// ============================================================
export function initPwa() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!window.isSecureContext && !/^localhost$|^127\.0\.0\.1$/.test(location.hostname || '')) {
    // SW 需要 HTTPS 或 localhost——本地 file:// 等场景静默跳过（不报错、不挡功能）
    return;
  }
  navigator.serviceWorker.register('js/sw.js', { scope: '/' })   // scope 显式 '/'：默认是脚本所在路径 /js/——页面将不受 SW 管辖
  .then(reg => {
    window.__zhSwReg = reg;                                  // 供验证脚本与设置页读取状态
    // 每次打开检查一次更新；另每小时兜底一次（长驻主屏幕会话）
    checkUpdate(reg);
    setInterval(() => checkUpdate(reg), 60 * 60 * 1000);
  }).catch(() => { /* 注册失败不影响应用正常运行 */ });
}

function checkUpdate(reg) {
  reg.update().then(() => {
    if (reg.waiting) showUpdateBanner(reg);
  }).catch(() => {});
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => {
      if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
    });
  });
}

function showUpdateBanner(reg) {
  if (document.getElementById('zh-update-banner')) return;   // 已显示
  const div = document.createElement('div');
  div.id = 'zh-update-banner';
  div.className = 'sw-update-banner';
  div.innerHTML = `<span>植伴有新版本已准备好</span><button type="button">点此更新</button>`;
  div.querySelector('button').addEventListener('click', async () => {
    // 用户主动点击才切换——此时不在编辑流程中，刷新安全
    reg.waiting && reg.waiting.postMessage('SKIP_WAITING');
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    // 兜底：个别浏览器 controllerchange 不触发
    setTimeout(() => location.reload(), 1500);
  });
  document.body.appendChild(div);
}
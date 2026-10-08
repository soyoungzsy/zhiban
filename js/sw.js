// ============================================================
// js/sw.js — Service Worker（线上 HTTPS + 主屏幕版）
//
// 范围刻意保持最小（指令：离线查看不得成为重构理由）：
//   · 预缓存应用外壳（页面/样式/全部 ES 模块/图标/manifest）——离线可打开
//     已保存的植物档案、养护基础资料、五行小卡（数据本就在本机 localStorage/IndexedDB）
//   · /api/* 一律网络直通、永不缓存——识别、真实天气离线时明确失败，
//     不把旧数据或失败响应当正常结果（前端 UI 已有降级文案）
//   · 页面导航 network-first、shell 静态 stale-while-revalidate——缓存不锁死更新
//   · 更新策略：新版本只"待命"，顶部横幅提示、由用户点击后才切换刷新——
//     绝不在用户编辑/批量识别过程中强制 reload
// ============================================================
const VERSION = 'zb-5.0.0-20261007';
const ASSETS = [
  '/', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/ui.js', 'js/db.js', 'js/store.js', 'js/home-model.js',
  'js/knowledge.js', 'js/city-db.js', 'js/plants-a.js', 'js/plants-b.js', 'js/plants-c.js',
  'js/engine.js', 'js/health-rules.js', 'js/services.js', 'js/vision.js', 'js/weather.js',
  'js/example-data.js', 'js/sw.js', 'js/pwa.js',
  'js/views/home.js', 'js/views/plant.js', 'js/views/add.js', 'js/views/health.js',
  'js/views/say.js', 'js/views/spaces.js', 'js/views/settings.js', 'js/views/batch.js',
  'icons/favicon-32.png', 'icons/apple-touch-icon-180.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 逐个预取：以 scope 解析为绝对 URL（SW 内相对路径基准是 sw.js 自身——曾把 css/... 解析成 /js/css/... 全 404）
    // index.html 带预缓存标记：服务端不把访问 key 写进缓存版；任一失败则本次放弃（不做空缓存假成功）
    await Promise.all(ASSETS.map(async a => {
      const rel = (a === '/' || a === 'index.html') ? 'index.html' : a;
      const abs = new URL(rel, self.registration.scope).href;
      const r = await fetch(abs, { headers: rel === 'index.html' ? { 'x-sw-precache': '1' } : {} });
      if (!r || !r.ok) throw new Error('precache 失败: ' + abs + ' → ' + (r ? r.status : '无响应'));
      await cache.put(abs, r);
    }));
    // 不 skipWaiting：等用户点"更新"横幅（pwa.js 发消息）才接管，避免编辑中被换版本
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    // 首次安装后接管已打开页面（离线验证与 controller 依赖）。
    // 更新场景 claim 只在用户点了横幅（SKIP_WAITING）后发生——不破坏"用户掌控刷新"。
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  // 仅由用户在更新横幅上主动点击触发（受控切换，非自动强刷）
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // 跨域直通

  // API：网络直通，永不缓存（POST 无缓存语义；GET 也走网络保证实时与失败如实）
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ error: 'offline', msg: '当前离线——识别和实时天气需要网络。已保存的档案与建议不受影响。' }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )));
    return;
  }

  // 页面导航：network-first（永远拿最新入口），离线才回退外壳缓存
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match('index.html');
        return cached || new Response('离线且无缓存', { status: 503 });
      }
    })());
    return;
  }

  // 外壳静态资源：cache-first 立即回，后台顺路刷新——旧缓存不会锁死更新
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fresh = fetch(req).then(r => {
      if (r && r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); }
      return r;
    }).catch(() => null);
    return cached || (await fresh) || new Response('离线资源缺失', { status: 503 });
  })());
});
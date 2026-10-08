// ============================================================
// test/screenshot.mjs — 真实运行截图（v3 第 10.3 条证据）
// 运行：先启动静态服务器（python3 -m http.server 8437），再 node test/screenshot.mjs
//
// 覆盖 v3 要求的最低清单 + 两条关键场景：
//   · 湿土萎蔫（T03）：08 号场景（sym=wilt&soil=wet&go=1）
//   · 位置同名但环境不同（T08）：02 号场景（两个「阳台」）
// 真实点击交互：05（点开大字卡）、07（点症状出追问）。
// 每个场景使用独立 Incognito Context + 独立 ?demo=1 安装，
// 场景之间零状态串扰；Chrome 154 真实渲染，等待关键元素后截图。
// ============================================================
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

fs.mkdirSync('screenshots', { recursive: true });   // 干净 clone 自建截图目录（.gitignore 照常排除，不入库）
const BASE = 'http://localhost:8437';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--window-size=390,844'],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freshPage() {
  const ctx = await browser.createBrowserContext();   // 独立会话：storage 互不串扰
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  return { ctx, page };
}

/** 场景：goto → 等待关键元素 → （可选）点击 → 截图 */
async function scene({ name, url, wait, waitAfter, clickSel, waitClicked, fullPage = false, shotDelay = 400 }) {
  const { ctx, page } = await freshPage();
  await page.goto(BASE + url, { waitUntil: 'networkidle0', timeout: 25000 });
  await page.waitForSelector(wait, { timeout: 15000 });
  if (clickSel) {
    await page.click(clickSel);
    await page.waitForSelector(waitClicked, { timeout: 8000 });
  }
  if (waitAfter) await page.waitForSelector(waitAfter, { timeout: 8000 });
  if (fullPage) {
    /* subpage 覆盖页是 fixed + overflow-y:auto 的内部滚动容器，
       文档高度恒等于视口——须先展开为自然文档流，整页截图才能覆盖全部内容。
       仅在截图瞬间注入，结束即随页面销毁，不影响应用行为。 */
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.id = 'shot-expand';
      st.textContent = [
        '.subpage{position:static!important;height:auto!important;min-height:0!important;overflow:visible!important}',
        '.topbar{position:static!important}',
        '.tabbar,#view{display:none!important}',
      ].join('\n');
      document.head.appendChild(st);
      window.scrollTo(0, 0);
    });
    await sleep(150);
  }
  await sleep(shotDelay);
  await page.screenshot({ path: 'screenshots/' + name, fullPage });
  console.log('[OK] ' + name);
  await ctx.close();
}

/* 1. 首页（周重点 + 位置筛选 + 示例横幅） */
await scene({ name: '01-home.png', url: '/?demo=1#/', wait: '#week-box .week-item' });

/* 2. 摆放位置页：两个同名「阳台」不同属性（关键场景 · T08） */
await scene({ fullPage: true, name: '02-spaces.png', url: '/?demo=1#/spaces', wait: '[data-edit]' });

/* 3. 植物档案（月季 · 露天阳台 + 黑斑观察 + 位置小结） */
await scene({ fullPage: true, name: '03-plant-yueji.png', url: '/?demo=1#/plant/ex-yueji', wait: '.plant-hero' });

/* 4. 档案页五行小卡预览区（绿萝：位置小结"合适" + 已校验行） */
await scene({ fullPage: true, name: '04-plant-card.png', url: '/?demo=1#/plant/ex-lvluo', wait: '.card-paper-mini' });

/* 5. 真实点击「养护小卡」→ 全屏大字卡 */
await scene({
  name: '05-card-big.png',
  url: '/?demo=1#/plant/ex-lvluo',
  wait: '#a-card',
  clickSel: '#a-card',
  waitClicked: '.card-fullmask .card-paper .cp-row',
});

/* 6. 症状选择入口（白掌 · 8 个可观察现象 + 未接入徽标） */
await scene({ name: '06-health-select.png', url: '/?demo=1#/health/ex-baizhang', wait: '[data-sym]' });

/* 7. 真实点击「叶片下垂蔫软」→ 出现盆土追问（T05） */
await scene({
  name: '07-health-followup.png',
  url: '/?demo=1#/health/ex-baizhang',
  wait: '[data-sym="wilt"]',
  clickSel: '[data-sym="wilt"]',
  waitClicked: '[data-fid="soil"]',
});

/* 8. 湿土萎蔫完整结果（关键场景 · T03：停浇/不确诊/不催肥） */
await scene({ fullPage: true, name: '08-health-result-wet-wilt.png', url: '/?demo=1&sym=wilt&soil=wet&go=1#/health/ex-baizhang', wait: '.result-step' });

/* 9. 多肉档案：个体差异"里侧晒不到" + 替代候选被雨淋风险排除（T10/T09） */
await scene({ fullPage: true, name: '09-plant-duorou-position.png', url: '/?demo=1#/plant/ex-duorou', wait: '.plant-hero' });

/* 10. 茉莉×走廊：光照未登记如实说"不猜"（T07） */
await scene({ fullPage: true, name: '10-plant-moli-unknown.png', url: '/?demo=1#/plant/ex-moli', wait: '.plant-hero' });

await browser.close();
console.log('完成：10 张截图已写入 screenshots/');
// ============================================================
// views/settings.js — 设置（v3）
//
// 内容（对齐 v3）：
//   · 功能接入状态：逐项分列（症状主路径=已内建 / 拍照识名 / 照片病虫害 /
//     照片环境 / 天气……），不合并宣称"AI 已/未接入"；
//   · 数据与隐私：照片分层（localStorage 档案 + IndexedDB 图片）；
//   · 备份与恢复（7.4）：导出含照片的全量 JSON；导入前自动留存"导入前"备份；
//   · 归档找回（§5）：多家庭迁移后归档数据完整，可导出迁移前备份；
//   · 示例数据（异步载入）；危险区清除；关于。
// ============================================================

import * as store from '../store.js';
import * as HM from '../home-model.js';
import { $, esc, toast, confirmDlg } from '../ui.js';
import { providers, downloadDataUrl } from '../services.js';
import { installExampleData, hasExampleData } from '../example-data.js';

const STATUS_CLS = s => /未接入/.test(s) ? 'st-off' : 'st-on';

export function render(root) {
  const draw = () => render(root);
  const hasDemo = hasExampleData();
  const kb = store.storageEstimateKB();
  const archived = HM.archivedRealFamilies();
  const corrupt = store.corruptInfo();      // v4 §6.B：损坏数据恢复入口（读取失败时可见）

  root.innerHTML = `
    <div class="h-page">设置</div>

    <div class="section-h"><h2>功能接入状态</h2><span class="tiny">逐项如实标注，不合并宣称</span></div>
    <div class="card">
      ${Object.values(providers).map(p => `
        <div class="set-row">
          <div>
            <b>${esc(p.name)}</b>
            <div class="tiny">${esc(p.note)}</div>
          </div>
          <span class="sr-status ${STATUS_CLS(p.status)}">${esc(p.status)}</span>
        </div>`).join('')}
      <div class="tiny mt8">接入真实服务时，密钥只放服务端、不进浏览器；本版没有任何云端调用。</div>
    </div>

    ${corrupt ? `
    <div class="section-h"><h2>数据异常待处理</h2></div>
    <div class="card note-warn">
      <div class="sub mb8"><b>上次读取档案数据失败</b>（约 ${new Date(corrupt.at).toLocaleString()}）。原始数据已原样备份在隔离存储里${corrupt.backedUp ? '' : '——但备份写入也失败了，请立即导出当前可用数据并考虑找人工恢复'}，不会被自动删除，也不影响你现在正常使用。</div>
      <div class="tiny mb8">读取时的问题：${esc(corrupt.message || '数据格式损坏')}。建议先导出这份原件（找懂的人也许能修复）；确认导出后再清除记录。</div>
      <div class="gap-btns">
        <button class="btn btn-primary" id="s-corruptexport">导出损坏数据的原件</button>
        ${corrupt.backedUp ? `<button class="btn btn-danger-outline" id="s-corruptclear">我已导出，清除这个记录</button>` : ''}
      </div>
    </div>` : ''}

    <div class="section-h"><h2>装到手机主屏幕</h2></div>
    <div class="card">
      <div class="sub mb8">像 App 一样：加到主屏幕后点图标直接打开，没有地址栏。<b>注意：它是网页应用（PWA），不是微信小程序</b>——但用起来一样一步到位。</div>
      <div class="sm"><span class="k">iPhone</span><span class="v">用系统 <b>Safari</b> 打开本页 → 底部<b>分享</b>按钮（方框带向上箭头）→ 下滑选<b>「添加到主屏幕」</b> → 右上角"添加"。</span></div>
      <div class="sm"><span class="k">安卓</span><span class="v">用 Chrome 打开 → 右上角<b>⋮</b> → <b>「添加到主屏幕 / 安装应用」</b>。</span></div>
      <div class="sm"><span class="k">在微信里</span><span class="v">微信不让网页加主屏幕——先点右上角<b>…</b> 选<b>「在浏览器打开」</b>（用 Safari/Chrome），再按上面操作。</span></div>
    </div>

    <div class="section-h"><h2>离线与更新</h2></div>
    <div class="card">
      <div class="sm"><span class="k">离线能看</span><span class="v">已保存的<b>植物档案、摆放位置、基础养护建议、五行小卡</b>——这些都在手机本机，没网也照常打开。</span></div>
      <div class="sm"><span class="k">离线不能</span><span class="v">新的<b>照片识别</b>和<b>实时天气</b>需要联网；离线时界面会直接说明"当前离线"，不假装成功，也不会把旧天气当实况显示。</span></div>
      <div class="sm"><span class="k">版本更新</span><span class="v">有新版时页面顶部出现绿色横幅「点此更新」——<b>何时更新由你决定</b>，正在编辑或批量识别时不会被强制刷新。</span></div>
    </div>

    <div class="section-h"><h2>数据与隐私</h2></div>
    <div class="card">
      <div class="sm"><span class="k">档案哪儿</span><span class="v">植物档案、照片和记录只存在<b>本设备的浏览器</b>（localStorage + IndexedDB），服务器<b>不保存</b>你的任何档案。</span></div>
      <div class="sm"><span class="k">识别</span><span class="v">用「整屋照片建档」时，<b>照片会发送</b>到你部署的这一个服务，再由它转发给视觉模型（智谱 GLM）做识别——发送的是压缩后的分析图，仅用于当次识别，服务端不存档不作他用。<b>不上传公开图床。</b></span></div>
      <div class="sm"><span class="k">天气</span><span class="v">实况/预报需联网：把<b>城市代表坐标</b>（不是你的实时定位）发到你部署的服务并转发和风天气获取。打开首页会自动刷新一次缓存（城市已确认时）。</span></div>
      <div class="sm"><span class="k">照片时间</span><span class="v">压缩后本机分层保存；文件时间仅作参考并明示局限，不默认当作实拍时间。</span></div>
      <div class="sm"><span class="k">语音</span><span class="v">只在你点「开始说」时调用浏览器自带识别，可改文字；音频与识别结果不进任何外部服务。</span></div>
      <div class="sm"><span class="k">定位</span><span class="v">仅用于由你确认的城市候选，<b>坐标从不保存</b>；单家庭下城市只在「摆放位置」里手动改，不随手机移动变化。</span></div>
      <div class="sm"><span class="k">占用</span><span class="v">档案约 ${kb > 0 ? kb + ' KB' : '未知'}；照片空间跟随设备配额（IndexedDB 通常远大于 5MB）。写入失败会明确提示，不静默丢数据。</span></div>
    </div>

    <div class="section-h"><h2>备份与恢复</h2><span class="tiny">导出一个文件，需要时再恢复</span></div>
    <div class="card">
      <div class="sub mb8">导出的 JSON 包含全部家庭、位置、植物、照片与观察记录。导入会<b>整体替换</b>本机数据，替换前自动另留一份"导入前"的本机备份。</div>
      <div class="gap-btns">
        <button class="btn btn-primary" id="s-export">导出备份文件</button>
        <label class="btn btn-outline" for="s-import">从备份文件恢复</label>
        <input type="file" id="s-import" accept="application/json,.json" hidden>
      </div>
      <div class="tiny mt8">建议换手机或清浏览器数据前导出一份；没有自动云备份。</div>
      <div class="tiny mt8"><b>换网址/换浏览器数据不互通</b>：档案存在"这个网址 × 这个浏览器"里。从旧地址（如局域网 http://192.168.*）转到新网址使用：先在旧页面「导出备份文件」，再到新页面「从备份文件恢复」——植物、照片、位置全部回来，不用重新建档。建议固定一个入口长期使用。</div>
      <div class="tiny mt8">更新应用版本不会清除档案（网页缓存更新与你的数据库是分开存储的）。</div>
    </div>

    ${archived.length ? `
    <div class="section-h"><h2>归档找回</h2></div>
    <div class="card">
      <div class="sub mb8">上有 ${archived.length} 个已归档的家庭（单家庭迁移时原样保留，正常页面不再显示）。导出"迁移前完整备份"可以把它们全部找回。</div>
      <button class="btn btn-outline btn-block" id="s-archexport">导出迁移前的完整备份</button>
    </div>` : ''}

    <div class="section-h"><h2>示例数据</h2></div>
    <div class="card">
      <div class="sub mb8">「示例之家」（杭州）演示完整能力：两个同名但环境不同的「阳台」、光照未补的「走廊」、里侧阴影的个体差异……全部内容带「示例」标记，可一键清除。</div>
      ${hasDemo
        ? `<button class="btn btn-outline" id="s-demo-del">清除示例数据（不影响真实内容）</button>`
        : `<button class="btn btn-primary" id="s-demo-add">载入示例数据</button>`}
    </div>

    <div class="section-h"><h2>危险区</h2></div>
    <div class="card">
      <div class="sub mb8">清除后<b>不可恢复</b>：家庭、位置、植物、照片与观察都会从本设备删除。清空前建议先导出备份。</div>
      <button class="btn btn-danger-outline btn-block" id="s-clear">清除全部数据</button>
    </div>

    <div class="section-h"><h2>关于</h2></div>
    <div class="card">
      <div class="sm"><span class="k">版本</span><span class="v">植伴 v5.0 · 整屋批量建档 · 线上主屏幕版（单家庭/症状排查/天气接入延续 v3/v4）</span></div>
      <div class="sm"><span class="k">本版变化</span><span class="v">单家庭收敛（旧多家庭数据自动归档可找回）；轻量摆放位置一次录入多盆复用并真正影响建议；首页位置筛选；「哪里不对」症状排查为正式主路径；照片 IndexedDB 分层与全量备份；白掌/月季错误养护推断修正。红线不变：无浇水账本、无打卡、无倒计时。</span></div>
      <div class="sm"><span class="k">交付形式</span><span class="v">手机优先的网页应用（PWA，可加到手机主屏幕离线查看档案）；部署与授权说明见 project 目录 REVIEW_PWA 与 DEPLOY 文档。</span></div>
    </div>
  `;

  /* 备份导出 */
  $('#s-export', root).addEventListener('click', async () => {
    try {
      const json = await HM.exportAll();
      const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
      downloadDataUrl(url, `zhiban-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toast('备份已导出（含照片），请妥存文件');
    } catch (e) { toast('导出失败：' + (e.message || e)); }
  });

  /* 损坏数据恢复（v4 §6.B）：原样导出 + 确认后清除标记 */
  const cexp = $('#s-corruptexport', root);
  if (cexp) cexp.addEventListener('click', () => {
    const raw = store.exportCorruptRaw(corrupt.backupKey);
    if (raw == null) return toast('原始备份已不在（可能已清除过），刷新看看');
    downloadDataUrl('data:application/json;charset=utf-8,' + encodeURIComponent(raw), `zhiban-损坏数据原件-${new Date(corrupt.at).toISOString().slice(0, 10)}.json`);
    toast('损坏数据的原件已导出，请妥存文件');
  });
  const cclr = $('#s-corruptclear', root);
  if (cclr) cclr.addEventListener('click', async () => {
    const ok = await confirmDlg({
      title: '清除损坏记录？',
      danger: true, okText: '已导出，清除',
      body: '请先点「导出损坏数据的原件」确认拿到文件——清除后这份原始备份会被删除（你正在使用的新数据不受影响）。',
    });
    if (!ok) return;
    store.clearCorrupt(corrupt.backupKey, { confirm: true });
    toast('已清除；如之后想找回旧数据，用导出的原件文件');
    draw();
  });

  /* 归档（多家庭迁移前备份）导出 */
  const arch = $('#s-archexport', root);
  if (arch) arch.addEventListener('click', () => {
    const json = HM.migrationBackupJSON();
    if (!json) return toast('没有找到迁移前的备份记录');
    downloadDataUrl('data:application/json;charset=utf-8,' + encodeURIComponent(json), 'zhiban-单家庭迁移前备份.json');
    toast('迁移前备份已导出，包含全部归档家庭数据');
  });

  /* 导入恢复 */
  $('#s-import', root).addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const ok = await confirmDlg({
      title: '从备份恢复？',
      danger: true, okText: '覆盖恢复',
      body: '导入将<b>整体替换</b>本机当前全部数据（家庭/位置/植物/照片/观察）。<br>替换前会自动留存本次导入前的本机数据。确认这个文件是你从植伴导出的备份。',
    });
    if (!ok) return;
    try {
      const text = await f.text();
      const r = await HM.importAll(text);
      toast(r.msg);
      if (r.ok) draw();
    } catch (err) { toast('导入失败：读不了这个文件（' + (err.message || err) + '）'); }
  });

  /* 示例（异步：照片分层保存） */
  const dAdd = $('#s-demo-add', root);
  if (dAdd) dAdd.addEventListener('click', async () => {
    const r = await installExampleData();
    if (!r.ok) toast(r.msg || '示例已存在');
    else { toast(r.msg); draw(); }
  });

  const dDel = $('#s-demo-del', root);
  if (dDel) dDel.addEventListener('click', async () => {
    const ok = await confirmDlg({
      title: '清除示例数据？',
      body: '只删除带「示例」标记的家庭与植物；你自己建的内容完全不受影响。',
      okText: '清除示例',
    });
    if (!ok) return;
    store.removeExamples();
    toast('示例已清除');
    draw();
  });

  $('#s-clear', root).addEventListener('click', async () => {
    const ok = await confirmDlg({
      title: '清除全部数据？',
      danger: true, okText: '全部清除',
      body: `将删除<b>全部</b>家庭、位置、植物、照片与观察记录，不可恢复。<br>清空前建议先「导出备份文件」。`,
    });
    if (!ok) return;
    store.clearAll();
    toast('已清空');
    location.hash = '#/home';
  });
}
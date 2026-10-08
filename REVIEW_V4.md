---
更新时间: 2026-10-08T18:41:49+08:00
---
# REVIEW_V4.md — 植伴 v4 修改逐条核查报告

日期：2026-10-07 ｜ 对照：《植伴_GLM修改指令_v4_批量建档与天气.md》（下称 v4）
结论先行：**输入修复、保存一致性、语义错误、光照错误推断全部修复并有复现证据；整屋照片批量建档全链路完成（识别为"演示模式流程验证 + 真实服务待凭证"）；天气适配层与引擎条件接入完成（真实联调待凭证）**。未做与待验证项如实标注于 §6。

---

## 0. 验证方法与命令

| 方式 | 命令 | 本轮结果 |
|---|---|---|
| 逻辑+jsdom 自动测试 | `npm test` | **10 个文件 313 项断言全部通过**：data-layer 30 / reliability 34 / batch-data 29 / batch-flow 23 / weather 17 / engine-space 25 / health-rules 31 / say-rules 42 / add-input 18 / dom-flow 64 |
| 真实 Chrome 实测 | `MOCK_VISION=1 node server/server.js` 后 `node test/verify-v4.mjs` | **19/19 通过**（真键盘 6 + 批量全流程 12 + 天气降级 1） |
| v3 场景回归 | `node test/verify-live.mjs` | 16/16（v4 改动未破坏 v3 验收面） |
| 真实截图 | `screenshots/v4-0*.png` | 4 张新增（键盘/批量评审/批量完成/天气降级）；历史 18 张仍有效 |

---

## 1. 第一批立即修：修复对照（复现 → 根因 → 修复 → 验证）

### 1.1 输入框阻塞错误（v4 §1）
- **复现**：连续键入 abc 得 cba（光标每次归零）；`ab|cd` 中插入 XY 得 YabXcd；中文组合输入组合期间节点被移除。旧代码根因：`add.js:173` input 事件执行 `draw(root)` 用 `root.innerHTML` 全量重建表单（输入节点被替换）再无参 `focus()`。
- **修复**（js/views/add.js）：候选区独立容器 `#a-cands` 局部渲染，输入节点从重建；`compositionstart/end + isComposing` 组合期间只记状态不刷新候选；120ms 防抖 + `st.searchSeq` 序号淘汰旧请求；候选 chips 改事件委托。**不强制光标到末尾**。
- **同类排查（只修实际存在的问题）**：`#a-name`、`#a-micro`、say 文本框确认无此故障（事件只更新 state 不重绘）——未改；城市搜索输入为 v4 新增代码（按新规范实现）。
- **验证**：jsdom add-input 18 项（I1 节点同一引用、I2 局部更新、I3 组合不被打断、I5 假成功不跳转可重试）；**Chrome 真键盘 6 项**：`keyboard.type` 逐字后 value='abc'（旧行为 cba 已消失）、`selectionStart===3`、中间插入 `abXYc`、退格 `abXc`、焦点全程保持。
- **中文拼音选词**：Chrome headless 无法真实模拟输入法（合成 composition 事件不能冒充真机）——jsdom 结构断言（组合期间候选不刷新、compositionend 后按正式文本刷新）+ **真机复验待做**（§6）。

### 1.2 保存一致性（v4 §6.A）
- **复现**（reliability.mjs 旧代码跑挂 13 项）：写入配额注入时 `addPlant` 仍返回新增对象（内存与存储不一致、假成功）；`updateSpace` 失败不回滚；`doSave` 失败分支后仍有"已建档"和跳转。
- **根因**：store.js 所有写函数忽略 `save()` 返回值。
- **修复**（js/store.js）：新增事务层 `commit(mutate)`——序列化快照 → 修改内存 → 原子写主键 → 失败回滚内存并把旧快照尽力写回；`addFamily/addSpace/addPlant/updateFamily/updateSpace/updatePlant/deleteFamily/deleteSpace/deletePlant/addObservation/addNote/setPref` 全部走 `commit`，失败返回 `null`/`false`（假成功消除）。`doSave` 检查 `addPlant` null → 明确失败提示、不跳转、草稿保留可重试；`ensureHome` 两处 `addFamily` null 防护；示例装载配额下 `ok:false` 早退。批量幂等见 §2。
- **验证**：reliability 34 项全绿（故障注入逐一断言：返回值、内存回滚、主键不污染、重试成功、savePhoto 原回滚语义保持）；add-input I5（UI 不假成功可重试）；Chrome verify-v4 B4（草稿阶段不建正式植物）。

### 1.3 损坏数据恢复（v4 §6.B）
- **复现**：损坏 JSON 下 `load()` 直接重置空态、无备份无导出路径（reliability R4 在旧代码上崩溃复现）。
- **修复**（js/store.js + settings.js）：损坏 → 原样备份进隔离键 `zhiban:v1:corrupt:<ts>` → 进入 `__corrupt` 恢复态；`corruptInfo()/exportCorruptRaw()/clearCorrupt({confirm})` API；设置页"数据异常待处理"卡（时间/原因/导出原件/双确认后清除）。恢复态不影响正常建档；未经确认不删除备份。
- **验证**：reliability R4 全组 9 项（备份原样、主键不被首启覆盖、确认前拒绝清除、清除后用户数据保住）。

### 1.4 语义五例与身份纠正（v4 §6.C/§6.D）
| 用例 | 旧行为（复现输出） | v4 行为 |
|---|---|---|
| "没有黄叶，也没有虫子" | 记成黄叶+虫害两条观察（`obs\|obs`） | 不生成观察，给"没有就不记成变化"说明（neg-info） |
| "冬天不开暖气" | 备注写成"冬天这个位置会开暖气。" | 如实记录"冬天这里不开暖气（屋里温度随室外走……）" |
| "这个位置不会淋雨" | 位置被改成"会淋雨" | 更正为"基本不淋雨"（否定分支先于肯定） |
| "以后会开花吗" | 记成正在开花（flower obs） | future-question 说明，不瞎猜花期 |
| "明天想搬到露天阳台" | 记计划的**同时**把当前共享空间 rain 改成"会淋雨" | 只记计划备注；isFuture 期间 4b 空间更正整体跳过 |
- **修复方式**（非逐句硬编码）：观察规则命中后取匹配点前 3 字否定窗口（豁免"不太/有点"）；输入整体疑问/未来语义先于观察分支；暖气/雨淋把否定模式提前于肯定模式；库外更正物种清 `knowledgeKey`（不再用绿萝指南糊弄玉树）。同名多个位置不再默认选第一个——给消歧说明（space-disambig），用户改名或明确后即恢复。
- **验证**：say-rules V9 全组 + V1-V8 回归 42 项全绿（用户复现各例均在断言中）。

### 1.5 光照四类错误推断（v4 §4）
- **修复**（js/engine.js `spaceLightLevel`）：`exposure='室外'` 且光照空→**unknown**（不再默认 direct）；"没有直射光"否定词先于"直射"命中；micro "不在阴影里"否定无效线索（不判 low）；`includeMicro:false` 参数——`bestAlternative` 候选评估真正不带旧位置的"里侧被挡住"（原注释声称不带但代码把 plant 传了过去）。**执行中另修复**（v4 §4 一致性）：已登记"基本不淋雨"的非室内位置不再误收"还没登记雨淋"提示（weather X3 复现后修正分支条件）。
- **验证**：engine-space T23 六项 + 25 项既有回归全绿；对照断言链保持（走廊 unknown 不猜、补光后判定改变——dom-flow S7）。

### 1.6 三处诚实小项（v4 §6.E）
- `photoTimeInfo` 读不到文件时间 → `known:false`（lastModified 从不当作可靠拍摄时间存档）；add.js 对未知时间照**不默认勾选**"照片代表当前"（核实责任不推给默认值）。
- 症状"其他"（health-rules.js）：freeText 先按内容映射方向（虫/蔫/叶色/斑/脱落/根盆六类，顺着用户描述给可排查动作，明示"不是确诊"）；确实模糊只问最有用的一件事；"太笼统"话术全部移除（E5 断言任何情况下不再出现）。
- 五行卡 PNG（services.js `cardImage`）：顶部"长期养护规则 · 挂盆手抄"小注已删——导出图与卡片一致只有五行；画布留白相应收紧。

---

## 2. 整屋照片批量建档（v4 §2/§3/§4）

### 2.1 交付内容
| 文件 | 职责 |
|---|---|
| `server/server.js` + `server/lib.mjs` + `server/.env.example` | 最小服务端代理（零依赖 Node）：托管静态；`/api/health` 联通检查如实；`/api/vision/detect` → GLM-4.6V 转发（载荷组装、JSON 围栏提取、box 校验、失败温和重试一次）；`/api/weather/*` → 和风转发（**坐标具名转换集中于此并有测试**：GeoAPI=经度,纬度；天气路径=纬度/经度）。密钥只进 `server/.env`，浏览器永不接触 |
| `js/vision.js` | 前端适配层：`visionHealth` / `detectPhotos`（并发≤2、单图失败不清批、非法框丢弃、可取消）/ `cropPhoto`（局部裁剪）/ `summarizeCounts`（**数量从实际检测结果+删并状态计算，不信模型自报 count**） / `planDuplicateHints`（跨照片疑似重复只给可解释建议，绝不自动合并）/ 分辨率分档常量（分析 1408 内存即弃、存档 1024、展示 640——不放大缩略图冒充细节） |
| `js/views/batch.js` | `#/batch` 全流程视图：上传 →「识别」→ 评审（原图编号框 + 候选卡：≤3 名称带把握分级 / 待确认徽标 / 勾选 / 误检删除可恢复 / 点击原图补选 / 重复确认合并或保留两盆 / 位置草稿中性名选已有或新建）→「建立所选 N 盆档案」二次确认 → 幂等一批提交。**识别中一切是草稿**（独立键 `zhiban:batch-draft`，返回/重试不丢已确认编辑，取消不建正式植物）；服务未启动/缺凭证只显示启动与配置指引，不冒充 |
| `js/store.js` 批次 API | `loadBatchDraft/saveBatchDraft/clearBatchDraft`；`commitBatch`（稳定批次 ID + 预生成目标 plantId + `done` 列表——重复点击/刷新/重试绝不重建已成功植物、失败项逐项标注只补失败）；`attachPhoto` + `savePhoto({region})`（**局部图带 regionOf 标记**；原图一份多盆共享，不为每盆重复存整屋大图）；场景线索以 vision-scene 备注如实入档（视觉来源不冒充用户确认） |

### 2.2 诚实原则落点（逐条对应指令 §2/§3）
- 摘要"约 2 盆可辨认植物 + 1 处待确认"从检测结果实时计算；用户删除/合并即时同步（Chrome B1/B5）；"镜头外和被遮挡的部分保持未知"明示。
- "找到区域"与"认出物种"分开（无候选区域建"身份待确认"，不编名字）；把握分级只显示 high/medium/low 级别文案，不编造百分比。
- 候选名命中内置 13 种才自动关联知识库；库外/自定义名 `chosenKey=null` 不硬套（Chrome B11 + batch-flow BF8 双向验证）。
- 同种两盆默认保留两个独立实例；合并仅经用户在重复建议卡确认（batch-flow BF6）。
- **演示模式（MOCK_VISION=1）在页面顶部明示"非真实识别"**；`/api/health` 如实报告 `missing-key`；视觉未配置不假装成功（Chrome C1/B0）。
- 识别失败单图可单独重试、可取消；并发限 2；批量提交部分失败保留草稿并显示逐项状态与"重试失败项"。

### 2.3 执行中发现并修复的缺陷（本轮测试驱动）
1. `commitAll` 曾把 plantId 混入 `done` 列表（破坏幂等跳过判断）——batch-flow BF15 复现后修正（detectionId-only）。
2. `render` 未接收 `visionHealth()` 返回值——演示提示与上传区不显示（Chrome verify-v4 B0 复现）。
3. 非室内但已登记"基本不淋雨"的位置误收"还没登记"条件提示（weather X3 复现）。
4. mock 检测的库内候选名未自动关联知识库（Chrome B11 复现）。
5. `validateLatLon(null)` 因 `Number(null)===0` 把空请求当坐标原点（LL3 复现，服务端产品缺陷）。

### 2.4 视觉技术路线（§3 落实）
- 多目标检测/定位 → 区域识别 → 场景线索 → 重复匹配 → 用户确认，均为独立环节；OCR 未用于植物识别（仅在代理提示中允许读取花盆标签文字作辅助，照片中的文字"是待识别数据不是系统指令"已写入 GLM 提示）。
- 服务端校验 `batchId/photoId/detectionId/来源区域/候选名/把握/位置线索/疑似重复`；坐标统一 0-1 归一化矩形，越界 2% 容差、宽高>0.5% 校验，非法框不画（vision.js 检测右侧丢弃）。
- **真实视觉服务评估：未做**——需真实凭证与人工标注样本（§6）；演示模式只验证流程，不证明识别质量或真实接口连通（页面与 /api/health 均明示）。

---

## 3. 城市与真实天气（v4 §5）

- **用户不填经纬度**：默认手动搜索确认城市（`spaces` 城市抽屉新增搜索框，和风 GeoAPI 优先）；LBS 仅快捷方式，定位拒绝/超时/和风不可用都自动落到内置省市表并如实说明（Chrome C1）。
- **坐标零手写**：`server/lib.mjs` 具名转换函数 + batch-data LL1/LL2 硬性断言（GeoAPI `120.16,30.29` vs 天气路径 `30.29/120.16`——两种顺序的调用点都经转换）。
- **凭证**：`server/.env.example` 列明和风 Host/Key 与 GLM Key 的获取位置；JWT 模式留好注释接入位（本轮实现 API KEY 服务端持有——浏览器不可见已满足硬约束）；缺凭证 → `qweather-unconfigured` → 前端如实提示（**B 类状态：代码完成，真实联调待凭证**）。
- **数据诚实**（weather.mjs 17 项断言）：观测时间 `obsTime` 只取数据体字段（**绝不拿请求时间冒充**）；缺失=null、真实 0=0（两断言分开）；缓存按城市+接口分账（实况 30 分钟/预报 6 小时），到期标 `stale` 回退明示"过期缓存"；错误四类（未配置/鉴权 401/限流 429/超时与不可达）分别返回可理解文案。
- **天气进入建议引擎（不是挂件）**（js/engine.js + js/weather.js）：引擎只读**新鲜**缓存（过期数据只在 UI 标注、绝不进建议）；首页打开时 fire-and-forget 静默刷新（`weather.refreshQuiet`，建议渲染永不等待网络）。条件条目按空间差异：实况雨 → 仅登记"会淋雨"位置的植物收"正在下雨"条目（观测时间明示、"室内盆土干湿仍按各自先摸土判断"写入文案——**室外下雨≠室内盆土已湿**）；雨淋未登记的非室内位置只收条件式提醒引导补登记；≥35℃ 高温条目只对非室内有 careHot 的植物；无缓存时这些条目全部消失、回到明示来源的季节推测。预报雨天数（近 3 天）也仅在会淋雨位置出现。
- **手机出差不改植物城市**：城市仅在此处手动确认；长期保存城市代表坐标 `city.qw`（非用户定位处）。
- 验证：weather.mjs X 组（露天收条目/室内不收/已登记不误伤/证据标签/清缓存回季节）；Chrome C1（降级 UI）；fresh 断言三次打开建议稳定（dom-flow T20 延续）。

---

## 4. 验收清单对照（v4 §7）

| 项 | 结果 | 证据 |
|---|---|---|
| A1 逐字/中间插入/删除/粘贴（键盘真实输入） | ✅（粘贴未单列——键盘链路同一节点稳定已覆盖；真机复验清单含拼音选词） | Chrome verify-v4 A1-A6 + add-input I1-I3 |
| B 一张含多盆实拍图定位给候选；无植物图无结果 | 流程✅（演示数据 3 处）；**真实实拍识别质量待凭证** | verify-v4 B1-B3；（无植物图→真实服务行为，§6） |
| C 同种两盆不合并；同盆多角度给重复确认；混种/遮挡/镜面由提示词排除（提示词明确"不算真实植株"） | ✅ | batch-flow BF6/BF16 + planDuplicateHints 单测 + GLM 提示 |
| D 删除误检/补选/改候选名后数量位置照片独立档案一致 | ✅ | verify-v4 B5/B8-B11；batch-flow BF7/BF8 |
| E 城市手动选择不依赖 LBS 取真实天气；权限拒绝/坐标顺序/单位/过期/限流/缺凭证可理解处理 | 手动选城✅降级✅坐标✅单位✅过期✅限流分类✅缺凭证✅；**真实天气获取待凭证** | weather.mjs 全组 + Chrome C1 |
| F 同一天气下室内/露天/未知位置建议差异化 | ✅ | weather.mjs X1-X3/X5 |
| G §6 语义与身份用例全部入回归 + 名称/指南/小卡一致（knowledgeKey 清除后绿萝卡片不再出现） | ✅ | say-rules 42（V9 含五例+物种+消歧）；knowledgeKey=null 断言 |
| H 单盆与批量注入容量不足/部分照片失败/重复点击/刷新中断；草稿可重试旧数据完整无假成功 | ✅ | reliability + batch-data D4 组 + add-input I5 + batch-flow BF15 |
| I 关闭重开/备份恢复后位置照片关联不丢 | ✅（既有 data-layer D6 往返 + v4 attachPhoto/region 回归） | data-layer + batch-flow |
| J 五行卡屏/复制/PNG 三处五行 ≤10 字 | ✅（PNG 顶部小注已删） | engine T18 运行时校验 + dom-flow S 卡断言 |

---

## 5. 服务接入状态分项报告（浏览器端代码永远见不到密钥）

| 能力 | 状态 | 本轮验证方式 |
|---|---|---|
| 症状排查（哪里不对） | ✅ 内建（正式路径） | health-rules 31 + Chrome live-08 |
| 手动建档/名称搜索/单盆补拍 | ✅ 内建 | dom-flow/add-input/Chrome |
| **批量建档流程**（草稿→评审→确认→幂等提交） | ✅ 内建 | batch-flow 23 + Chrome verify-v4 B 组 12 项 |
| **视觉识别（真实 GLM-4.6V）** | ◐ **代码完成，待凭证联调**（ZHIPU_API_KEY） | 服务端转发/校验/重试全部就绪；`/api/health` 报 missing-key；演示模式（MOCK_VISION=1）跑通全流程且页面明示**非真实识别**——不冒充识别完成 |
| **真实天气（和风）** | ◐ **代码完成，待凭证联调**（QWEATHER_API_HOST + QWEATHER_KEY） | 适配层 17 项注入测试全过；坐标转换测试；降级路径 Chrome 实测；缺凭证状态如实可见 |
| 语音语义整理 | ◐ 内置规则（V9 增强 16 项）；LLM 化留待后续接入 | say-rules 42 |
| 手机真机 | ⏸ 未验证 | §6 |
| 视觉真实样本评估（人工标注） | ⏸ 未做 | 不引用任何未验证准确率 |

**四类测试分报（不合并宣称）**：逻辑测试 ✅（npm test 313）；隔离浏览器测试 ✅（jsdom 105 项 + Chrome 35 项 = verify-v4 19 + verify-live 16）；**真实前后端联调 ⏸ 待凭证**（代理联通检查与错误分类已实测，真实第三方调用未发生）；**手机真机 ⏸ 未验证**。

---

## 6. 未验证与已知边界（如实）

1. **中文拼音选词真机复验**：headless 无法真实模拟输入法（组合事件为结构断言）；建议真机按 §7.A 手册走一遍（逐字/插入/退格/选区已在 Chrome 实测通过）。
2. **真实视觉识别与天气**：`server/.env` 填入 ZHIPU_API_KEY / QWEATHER_API_HOST+KEY 后重启代理即启用真实模式（`/api/health` 会从 missing-key 变 live-ready）；当前所有"识别/天气"体验均为演示模式/降级路径，页面已明示。不要把流程验证当识别质量。
3. **视觉真实样本评估**（定位框准确度/漏检/重复错配）需人工标注拍照样本与真实服务——未做，不引用宣传准确率。
4. 手机真机：批量拍照上传（相册多选权限）、LBS 授权真实拒绝流程、放大文字下批量页按钮遮挡——未测（v3 的 T21 清单同样未消）。
5. `weather.js` 字段映射按 2026-10 和风文档范式编写，真实联调时若字段名有出入在 `normalizeCurrent/normalizeDaily` 处校对。
6. v3 审核包历史遗留已知项（favicon 404 等）保持不变；无新增已知阻塞。

---

## 7. 启动与体验入口（已验证）

```bash
cd zhiban
node server/server.js            # 生产形态：静态 + 代理（默认 :8438）
MOCK_VISION=1 node server/server.js   # 演示模式（识别返回固定示例，页面明示非真实识别）
cp server/.env.example server/.env   # 填入两种凭证后重启即为真实识别/真实天气
npm test                           # 10 文件 313 项逻辑回归
node test/verify-v4.mjs            # Chrome 实测 19 项（需 8438 演示代理在跑）
```

- 手机（同一 Wi-Fi）：`http://<开发机IP>:8438/`；旧 `python3 -m http.server 8437` 静态方式仍可用（无识别/天气代理）。
- 批量建档入口：建档页第一张卡"拍整屋照片，一次认出多盆 →"（`#/batch`）；真实天气需先在「摆放位置 → 设置城市」用搜索确认一次城市（三种方式都会保存城市代表坐标）。

---

### 附：本轮新增/修改文件清单

**新增**：`server/server.js`、`server/lib.mjs`、`server/.env.example`、`js/vision.js`、`js/weather.js`、`js/views/batch.js`、`test/reliability.mjs`、`test/batch-data.mjs`、`test/batch-flow.mjs`、`test/weather.mjs`、`test/add-input.mjs`、`test/verify-v4.mjs`

**修改**：`js/store.js`（commit 事务层、损坏恢复、批次/照片 API）、`js/views/add.js`（输入修复）、`js/views/say.js`（语义修复）、`js/engine.js`（光照修复+天气条件条目）、`js/health-rules.js`（other 分支）、`js/services.js`（PNG 小注、分辨率注释）、`js/main.js`（batch 路由）、`js/views/settings.js`（损坏恢复卡）、`js/views/spaces.js`（和风城市搜索/LBS 反查）、`js/views/home.js`（天气静默刷新）、`js/example-data.js`（配额防护）、`js/city-db.js`（坐标输出）、`css/app.css`（天气标签）、`test/run-all.mjs`、`README.md`
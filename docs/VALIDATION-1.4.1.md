# v1.4.1 面板验证（2026-11-22）

同一个真实 SillyTavern 1.19.1（release 提交 `82b64a45c34facbc98ff4b9f33c067d3ccab6a17`），分别在空的临时账户中安装 v1.4.0 与 v1.4.1。初始模式、范围、注入方式、思考预算与反馈图一致：`observe / lin / pair / keep`。使用 Chromium 133 的触屏输入和窄屏视口；没有使用用户账号、真实 iPhone、TauriTavern 或付费模型。

|检查|实际结果|
|---|---|
|旧版复现|在「原样诊断」下，三个原生 select 都可见且具有 disabled 状态。点击不响应。原因是旧版刷新界面时把是否能编辑和是否会应用混为一谈。|
|点击及持久化|在新界面直接点选三行右侧的文字区域，改成 `all / user / balanced`，模式始终为 `observe`。等真实宿主写入隔离账户 settings.json 后刷新，三个值和界面选中状态均保留。三行的命中高度实测均为 44 CSS px。|
|说明和误触|19 个可保存的设置各有一份操作指引和例子，通过触屏逐个展开再收起，所有账户设置保持不变。切换一条／两条后示例立即更新；键盘方向键、Home 键可换页。整个设置试用捕获到 **0 次模型生成请求**。|
|版本、工作模式和开关|只做诊断时旧版三项可编辑，但不会激活增强；关闭扩展时可备选。载入提供的 Lin 2.9.0 后仍不使用旧版三项；识别到原生 Google 搜索时说明实验会跳过。测试对照 prompts、prompt_order、extensions 和搜索设置的摘要值，触控操作前后一致。|
|不同屏宽|320 / 375 / 430 / 1024 CSS px 四种视口逐页检查；面板没有横向溢出，四个分页按钮均不矮于 44 CSS px。|
|静态与单元|17 个浏览器模块语法检查通过；372 项中 313 通过、59 个历史外部样本用例跳过、0 失败。v1.4.1 的 3 项新检查核对帮助覆盖与请求代码的示例：1 条／2 条、旧版范围、Gemini high／auto，以及 2.9 和诊断模式隔离。|
|出站回归|46 个浏览器回环请求用例通过；另经完整酒馆前端、后端及其 custom / AI Studio / Vertex 适配器比较 16 个请求，最终接收者是本机协议替身。保留原有搜索工具，未触及真实 Google 路由或生成效果。|

原始结果：[旧面板](../evidence/v141/before.json) · [新面板](../evidence/v141/after.json) · [宿主出站对照](../evidence/v141/host.json)；命令摘要和控制台结果也在同一目录。旧版复现中的“禁用”属于应用代码行为，不是对所有 iOS 浏览器触控实现的判断。本次没有验证上游是否截断，也不把本地通过折算成防截断成功率。

## 本地复现

已有 Node 20+、Python Playwright、Chromium 及装好依赖的指定版本官方酒馆时：

```sh
export CHROMIUM=/path/to/chromium
export LPG_ST_PATH=/path/to/SillyTavern
export LIN290_PRESET=/path/to/the-original-lin-2.9.0.json
npm run check
npm test
npm run test:phone -- --old /path/to/lin-prefill-guard-1.4.0 --out /tmp/lin-ui-before
npm run test:phone -- --out /tmp/lin-ui-after
npm run test:browser
LPG_ST_REPORT=/tmp/lin-real-host.json npm run test:st
```

用于旧版对照的代码提交为 `06ba69b5dfb1d9a5877940d051778636a5f75b46`。UI 测试不向任何外部模型发请求。浏览器与宿主回环测试使用合成回复；中文截图来自实际酒馆页面。安装插件本身无需这些开发依赖。

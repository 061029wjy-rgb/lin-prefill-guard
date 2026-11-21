# v1.4.0 验收记录（2026-11-21）

这里将代码回归、真正发出去的 HTTP 请求和真实云模型效果分开计数。所有 RP 输入均为合成剧情；预设文件只读，不随包分发。生成用的 HTTP 接收器只监听本机，不需要任何模型账户。

|检验层级|实际执行|能证明什么|
|---|---|---|
|原仓库 v1.3.0|基线 `475c555bca1831c402554b1262c762ce85911096`；检查通过；331 项中 272 通过、59 个可选历史用例跳过、0 失败。|修改前的对照；跳过项没有算入通过数。|
|v1.4.0 静态/Node|Node 24.22.3；15 个浏览器模块及测试/辅助脚本通过语法检查；369 项中 **310 通过、59 跳过、0 失败**。Lin 2.9 原件已提供，新增涉及原件的用例已执行。P0 子集 25/25。|结构与反例、诊断、旧版回归；59 个旧用例依赖本次未配置的历史样本环境变量。不能当作真实模型实测。|
|Chromium 真网络、宿主事件替身|Chromium 133.0.6943.0；**46 组生成请求**从浏览器发到本地 HTTP 服务，其中 12 组使用原件两套顺序做同输入比较。另测一键还原后下一次 POST 字节完全一致、无关文件上传、停止/卸载/重载和 3 次隔离工具往返。|不仅核对函数返回值，还核对接收端实际请求体与浏览器真实响应字节；没有调用模型。|
|真实 SillyTavern 前后端|官方 v1.19.1，提交 `82b64a45c34facbc98ff4b9f33c067d3ccab6a17`，安装扩展到测试账户。**16 次**：自定义 Chat Completions 6 次；AI Studio 和 Vertex 两个酒馆后端各 5 次。三个接收端协议都在本机模拟。|插件由酒馆自己加载，用原件由宿主 Prompt Manager 组装、展开一次，再用同一份消息快照比较。通过真实设置事件、生成 API、后端转换、HTTP 接收器；不是用户云端 Google 鉴权/推理，也不是 TauriTavern 真机。|
|额外转换与历史对照|固定版本酒馆 Google 转换器 12 组；2.8.2 对 v1.3.0 的完整请求计划深比较 16 组（2 个模式 × 4 种请求 × 正序/倒置，含旧版可选输出上限）。|任何有新增系统内容的样本，仅移除本插件新段以后比较；其余字段逐项相同。|
|真实模型、缓存与文学盲评|真实模型调用 **0**。已离线准备 12 个剧情 × 6 种组合 = **72** 个盲评样本。|没有拒答/截断率、缓存收益、模型实际路由、质量优劣或某个别名的真实身份结论。|

## 实际请求长什么样

在真实酒馆测试中，原件组装出 33 条消息。原 assistant 承接和末尾 user 确认各只出现一次。自定义连接 6 组共用同一组原有消息：全关时没有额外消息；另 5 组均只新增一条 `messages[26]`。删除这一条，再比较原 user、assistant 和所有其他字段，浏览器及酒馆后端接收端均完全一致。

在 AI Studio 和 Vertex 酒馆适配器中，先从同一快照生成一份各自的关闭对照。网页搜索关闭时，标准或深度＋随机各在系统指令的 `parts[26]` 增加一段，`contents`、生成参数等与相应对照一致。在**网页搜索启用**时，每个适配器实际测了“实验全关”和“深度＋随机”：酒馆后端都在最终协议中加入了搜索工具。两组都没有增加辅助段，后端完整请求一致；插件亦未关闭搜索。这里验证的是酒馆适配器的字段，而不是 Google 服务行为。

浏览器保护反例包括：规划后文本被其他扩展改变、切换聊天、签名、结构化输出（含顶层 MIME）、外部原生前缀、工具、继续和静默。相应测试收到原始字节。另有一个**允许的差异**：两条已知尾部正好放反时，实验都关着也可以把两个原对象调回；这种情况下净增是 0 字节，但顺序发生了变化。它不等于“任何 0 字节差都是请求完全没变”。

原预设 SHA-256：`bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766`，开发前后相同。93 条提示词、19 条正则、两组顺序与两段承接的单独指纹见 [preset-digests.json](../evidence/preset-digests.json)。最终 user 原文为 1,258 个 Unicode 码点（JavaScript 的 `length` 是 1,260）。没有把这个长度当成生成 token 或正文字数。

## 证据入口

- [基线检查](../evidence/baseline-check.txt)、[基线原始结果](../evidence/baseline-test.txt)、[发布检查](../evidence/check.txt)、[发布测试全部原始输出](../evidence/tests.txt)、[P0 子集](../evidence/p0.txt)。
- [浏览器逐条差异、字节与哈希](../evidence/browser-diffs.json)、[浏览器原始输出](../evidence/browser.txt)、[真实酒馆逐次结果](../evidence/real-st.json)、[酒馆原始输出](../evidence/real-st.txt)、[旧计划与转换器对照](../evidence/host-replay.txt)。
- [盲评用例及评分焦点](../fixtures/literary-cases.json)、[离线准备与空评分输出](../evidence/ab.txt)。实验包不收录用户的完整预设、宏展开快照、第三方脚本、完整工具签名或认证数据。
- 宿主依据：[插件设置事件与生成 POST](https://github.com/SillyTavern/SillyTavern/blob/82b64a45c34facbc98ff4b9f33c067d3ccab6a17/public/scripts/openai.js#L3145-L3152)、[Google 后端添加搜索工具](https://github.com/SillyTavern/SillyTavern/blob/82b64a45c34facbc98ff4b9f33c067d3ccab6a17/src/endpoints/backends/chat-completions.js#L596-L602)、[Google 消息转换器](https://github.com/SillyTavern/SillyTavern/blob/82b64a45c34facbc98ff4b9f33c067d3ccab6a17/src/prompt-converters.js)。本版只需一个生成发送边界。

## 复现

在插件目录运行；`LIN290_PRESET` 指向未改过的这份 Lin 2.9.0 JSON。未提供时，需要原文件的用例会显示 SKIP。安装插件无需运行这些命令。

```sh
export LIN290_PRESET=/path/to/lin2.9.0-测试.json
npm run check
npm test
npm run test:p0
```

网络验证另需 Python 的 Playwright、可执行 Chromium 和临时目录。真实酒馆验证还需已按其依赖锁安装的固定版本官方酒馆，脚本会创建单独的临时账户/配置，仅联系本地服务，结束后关闭测试进程。

```sh
export CHROMIUM=/path/to/chromium
export LPG_ST_PATH=/path/to/SillyTavern
LPG_BROWSER_REPORT=/tmp/lin-browser.json npm run test:browser
LPG_ST_REPORT=/tmp/lin-st.json npm run test:st
```

旧版对照：`node scripts/host-replay.mjs CONVERTER.mjs LIN29.json LIN28.json OLD/core.js`。取上述固定提交的 `src/prompt-converters.js` 原字节保存为 `CONVERTER.mjs`；本次其 SHA-256 为 `eadc6ccd7961273c887c0986c2ed1ffe61e2e7da03f83afeb8ba4dc5a5041a13`，测试副本同目录提供 `util.js` 的两个小型替身：`getConfigValue(key,fallback)` 返回 fallback，`tryParse(s)` 返回可解析 JSON、否则 null。OLD 是上述 1.3.0 插件目录。完整酒馆测试不使用这些替身。

相同条件下做云端盲评时，可先在本地建立测试包（不会发请求）：

```sh
node scripts/ab.mjs prepare "$LIN290_PRESET" new-private-batch
node scripts/ab.mjs score new-private-batch
```

用例覆盖多人物知情、角色权限、长线承接、混合情绪、反翻旧账、反八股、摘要与组件、尾部确认和普通物件。每个样本固定同一份简化宏展开、测试模型标签、采样、历史与已有 nonce；此离线对照明确按纯文本、关闭网页搜索准备。它不是生产宿主转录。选择同一真实模型与渠道分别执行时，记录结束原因、拒答、空回、截断、任务与格式完成度、延迟和供应商实际报出的输入/缓存 token；不知道就留空。评分者只看盲编号，按角色权限、无凭空知情、语言自然、正文与组件、任务完成各打 1–5 分（1 明确违反；3 部分做到；5 完整做到）。不要混合不同中转、模型或设置统计。手工填 `ratings.json` 后运行 score 分组汇总，`key.json` 只在揭盲时使用。生成的 `requests.json` 含自己的预设，应保留在本机。

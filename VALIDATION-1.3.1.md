# 1.3.1 验证记录

基线是用户提供的组合 ZIP 内 `lin-prefill-guard` 1.3.0，不包含组合包内 `human-temper` 的修改。验证日期 2026-11-25（北京时间）。

| 样本 | SHA-256 |
| --- | --- |
| 原组合 ZIP | `a0575d8ebb4ef01b1242ea18c9992bffdf4c004fc209bf3fe32a6ac644dca0ff` |
| Lin 2.9.1 原版 | `79425364f929723df789af37ddd9f9806db9e845ee14e27a4f919de8683c4f70` |
| Lin 2.9.1 尾部修订版 | `2cdd746b2e6e2a1197c51e010fdacdd1db750e5eaede1c9a7237fcc78ee7e2e8` |

## 预设和请求的差异

两份均为 93 个定义，只有同一 UUID 的末尾 user 确认发生文本变化；1,258 → 1,324 个 Unicode 字符。修订版第二套顺序还关闭了「伪思考闭合」，移除了两个原本未启用的可选 CoT 顺序项，未删定义。设置组 100000/100001 原版启用 55/61 条，修订版 55/60 条；NPC 优化分别关/开。其他参数未变。

1.3.0 对这次目标在 Gemini 4 两种处理模式返回 `g4-not-lin282`。1.3.1 以实际生效组、承接和确认的 UUID、角色和当前原文确认，不把文学内容写回预设。修订版普通兼容与 Vertex 均用整条预设确认收尾；旧版 2.9.1 的 Vertex 方法只在显式选择、条件满足时添加短确认。修订版 Vertex 模式可见 `g291-authored-ready` / `g291-authored-restored`。若要求保护实际工具、前缀、多候选、续传或碰到来源不清的文字，跳过改动。

## 测了什么

- Node v24.22.3：`npm run check` 通过。1.3.0 基线 338 项：279 通过、59 跳过。1.3.1 共 381 项：322 通过、59 个其他旧附件用例跳过、0 失败。43 个新增测试全部运行，包括两份真实 2.9.1、旧 2.8.2、原文更新、顺序、同一请求重复触发、明确开启的预算调整、工具与私有诊断不泄露原文。
- 真实本地宿主：SillyTavern 1.19.1（`82b64a45c34facbc98ff4b9f33c067d3ccab6a17`）、Chromium 133.0.6943.0，390×844 触屏视口。实际调用 ST 的消息组装、打开扩展设置、自检、发送、重生成及滑动，并检查酒馆保存的选中回复。
- 对每份用户预设、每套提示顺序分别跑 10 个发包场景，再对每份跑 3 个完整生成。共 40 次发包对照 + 6 次完整聊天。安装未改的情绪插件 1.2.0。比较设置事件前的可序列化请求和浏览器实际 POST：只允许预期的两条消息顺序、旧方案短确认、或用户显式选择的上限变化。核对酒馆后端转换后的 Google 请求、搜索开关、末尾角色、两条原文各一次。修订版两组均没有已关闭的「伪思考闭合」，只有启用 NPC 的组包含其原文。
- 出站目标是隔离的本地响应器：先观察浏览器发给酒馆的请求，测试工具才把后端目的地导到回环地址。真实云调用为 0。没有测试 Google 的内部路由或实际思考用量；不宣称实机 iOS / TauriTavern / 付费 Vertex 验证。
- 脱敏运行结果：[原版](validation/host-original.json)、[修订版](validation/host-revised.json)。不分发用户预设及聊天诊断原件。

## 重跑

```sh
# 下面的路径请换成你本机的文件。只有测试用得上；平时无需配置环境变量。
export LIN291_PRESET="/path/to/original-291.json"
export LIN291_EDITED_PRESET="/path/to/edited-291.json"
export LIN282_PRESET="/path/to/lin282.json"
npm run check
npm test

# 真实宿主夹具另需已安装依赖的上述 ST、Python Playwright 与 Chromium；测试只用临时账户。
export LPG_ST_PATH="/path/to/SillyTavern"
export CHROMIUM="/path/to/chromium"
export LPG_COMPANION_ZIP="/path/to/original-combined.zip"
LIN291_HOST_PRESET="$LIN291_PRESET" LPG_EVIDENCE=/tmp/guard-original npm run test:st291
LIN291_HOST_PRESET="$LIN291_EDITED_PRESET" LPG_EVIDENCE=/tmp/guard-edited npm run test:st291
```

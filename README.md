# Lin 预填充助手 v1.5.0

SillyTavern 扩展。原生预填充使用预设的原 assistant 承接作为回复前缀。确认条目及预设尾部其他规则保留完整原文。扩展在发送事件中整理尾部，fetch 读取响应副本并记录接口实报的 token 用量。

## 安装

1. 解压 ZIP，用包里的 `lin-prefill-guard` 文件夹替换原扩展目录里的同名文件夹。沿用原安装位置，打开这一层应直接看到 `manifest.json`。
2. 刷新酒馆，在 **扩展 → Lin 预填充助手** 确认显示 **v1.5.0**。旧「承接兼容」和「Vertex 正文承接」会切到「原生预填充」。已有的启用和网络取证开关、历史记录和明确选择的诊断或旧版增强模式会继续使用。
3. 保持 Lin 预设照常使用。面板的「本地自检」可检查当前配置，「发送」行显示实际浏览器请求的核对结果。

## 支持的连接

| 连接 | 发送时使用的协议 |
| --- | --- |
| 直连 Mistral、DeepSeek Beta | 原承接作为末尾 assistant，带 `prefix: true`。 |
| 直连支持前缀的 Claude 4.5 及更早型号 | 思考关闭时，原承接作为最后一条 assistant。 |
| Vertex / Google AI Studio 的专用反向代理 | 只有转发服务明确支持末尾 `model` 为真前缀，才勾选面板中的对应选项。声明绑定当前连接的转发地址和模型。仍需服务端按它声明的协议处理。 |
| 官方 Gemini 4、能力未知的 Google 转发 | 保留正确的原承接顺序。两条已核实原文确实颠倒时恢复为 assistant 承接、完整 user 确认。 |

两个 2.9.3 预设的承接和确认原文相同。原版的 `auto`、FY 版的 `max`、CoT、伪思考闭合及 NPC 设置仍由各自预设控制。对普通、重生成和滑动，只有认出尾部原条目时才处理。停止序列、温度、输出上限和其他生成参数继续取自酒馆。

历史里的附件、签名和已完成工具调用保持在原位置。尾部待移动条目有受保护字段时做只读核对。诊断按从 0 开始的消息索引列出历史或尾段、角色、字段路径和内容类型。工具回合、结构化输出和继续补全仍按酒馆协议处理。

## Token 取证

开启「发送与接口取证」后，记录可获得的输入、输出、思考及总 token。发送证据位于浏览器到酒馆之间。接口或转发只返回部分统计时，其他值显示为「渠道未提供」。

SillyTavern **1.19.1** 的 Google 和 Claude 非流式包装会省略上游用量。自行维护这一版本的酒馆时，可将 `compat/st-1.19.1-token-usage.patch` 复制到酒馆根目录后运行以下命令并重启。补丁只透传响应已有用量字段。

```sh
git apply --check st-1.19.1-token-usage.patch
git apply st-1.19.1-token-usage.patch
```

需要撤回时运行 `git apply -R st-1.19.1-token-usage.patch`，然后重启酒馆。

## 验证

运行 `npm run check` 和 `npm test`。测试覆盖两份 2.9.3 预设的顺序组、旧 2.6 有序承接、保护字段、重复组装、真实本地 POST、SSE 用量和 SillyTavern 1.19.1 的原始后端转换函数。真实预设测试可设置 `LIN293_PRESET`、`LIN293_FY_PRESET`、`LIN26_PRESET_PATH`，宿主转换测试需要 `LPG_ST_PATH`。上游响应采用固定测试数据。

[基线仓库](https://github.com/061029wjy-rgb/lin-prefill-guard/tree/46bba0b1bf2b533069e12d80c76ac31d27f65401) · [SillyTavern 1.19.1 宿主源码](https://github.com/SillyTavern/SillyTavern/tree/82b64a45c34facbc98ff4b9f33c067d3ccab6a17) · [许可](LICENSE)

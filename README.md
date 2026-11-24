# Lin 预填充助手 1.3.2

SillyTavern 聊天补全扩展。它核对 Lin 2.9.1 的剧情承接与最后一条用户确认，并在当前请求中保留这两条原文。Google AI Studio 和 Vertex AI 上的 Gemini 4 Carbon、Argon 使用对话历史承接剧情。Google 的接口要求移除预填的末尾模型轮次。[Google 迁移说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate)

## 安装

1. 解压整合包。把 `lin-prefill-guard` 文件夹放到酒馆的扩展目录。升级时先把旧文件夹备份到扩展目录外，再替换。新的文件夹打开后应直接看到 `manifest.json`。
2. 在酒馆的**聊天补全预设**中导入同包的 `Lin-2.9.1-低思考.json`，并选中它。这个名字可以和原版并存。刷新酒馆，在**扩展 → Lin 预填充助手**核对版本 **1.3.2**，请求处理选**承接兼容**。
3. 使用原版 SillyTavern 1.19.1 的用户，在运行酒馆的服务器上按下一节安装转发补丁，再重启酒馆。手机浏览器连接远端酒馆时，由服务器管理员执行这一步。

## 给 1.19.1 安装思考参数转发补丁

1.19.1 的浏览器会读取预设的低档和摘要开关。它自带的 Google 后端仅给名单里的模型构造 `thinkingConfig`，名单漏掉了 Gemini 4。单独刷新网页或换预设无法补全服务器端字段。

将扩展里的 `compat/st-1.19.1-gemini4.patch` 复制到 **SillyTavern 根目录**，也就是放有 `server.js` 的文件夹。在这个目录打开终端，依次运行以下两行。第一行检查当前源文件能否套用，第二行应用补丁。

```sh
git apply --check st-1.19.1-gemini4.patch
git apply st-1.19.1-gemini4.patch
```

检查成功时终端通常没有输出。应用后重启酒馆服务。补丁只修改 `src/endpoints/backends/chat-completions.js`，适配范围已在版本 1.19.1 验证。使用其他分支或托管客户端时，可让维护者核对 Google 出站请求是否已有 `thinkingConfig.thinkingLevel = LOW` 和 `includeThoughts = false`。恢复本次补丁可在同一目录运行 `git apply -R st-1.19.1-gemini4.patch` 后重启。

## 正常发送时会发生什么

| 情况 | 行为 |
| --- | --- |
| Lin 2.9.1 尾部顺序正确 | 普通发送、重新生成、滑动重抽沿用原 assistant 承接和完整 user 确认。恰好反序时，仅在两条原文均唯一匹配后交换。 |
| 预设填有其他接口的回复前缀 | 在直连 Carbon、Argon 上，插件检查本次待发请求。未实际发送的预设字段不会阻止核对顺序。若请求实际带有冲突的前缀，则显示原因并保留请求供排查。 |
| 低档且关闭返回摘要 | 预设和本次请求均明确选择这两个设置时，扩展给可核对的 Lin 2.9.1 直连请求加上酒馆本地标记。配套补丁将这两个设置转换为 Google 字段，并移除这两个模型不接受的温度、top P 和 top K。标记留在酒馆内。 |
| 自定义连接、代理、模型别名、工具或受保护的消息结构 | 跳过此低档适配。用户手动继续时，仅对受支持的纯文本 user 收尾请求转发设置。原版酒馆或渠道仍可按自身能力处理参数。 |
| 原样诊断 | 观察原请求。升级会沿用旧模式，选了这个模式的用户可切换到“承接兼容”启用转发。 |

可选的“Vertex 正文承接”继续支持 2.9.1 自带的“【生成交接】”。在这份配套预设中，整条原确认留在最后。2.8.2 的旧版承接逻辑仍可使用。放宽输出上限是单独的开关，默认为关闭。

## 核对最近一轮

在扩展中开启网络取证，正常发送一次后查看最近记录。**浏览器发送**显示酒馆收到的档位及摘要开关。出现**酒馆后端已组装 LOW 和 includeThoughts=false** 表示配套补丁给本次 Google 请求写入了两个字段。其他实现可能正常转发但没有这个回执，可用服务器出站记录核对。

**思考 token** 是服务报告的内部用量。**原生摘要字符**是当前回包中可识别的摘要长度。**正文内 Lin_CoT 字符**是预设要求生成的文本块。Carbon、Argon 的最低可选档位是 LOW，仍可产生思考 token。关闭摘要保留预设自己启用的正文格式。[Google 思考设置](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)

配套 JSON 的生成设置只改了 `show_thoughts` 和 `reasoning_effort`，并使用独立导入名称。93 个提示条目、两套提示顺序和 19 个正则脚本均与上传的 Lin 2.9.1 一致。

[本版本验证](VALIDATION-1.3.2.md) · [上一版验证](VALIDATION-1.3.1.md) · [许可证](LICENSE)

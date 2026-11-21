# 1.2.2 验证记录

日期：2026-10-20。

## 已执行

- 7 个运行模块通过语法检查：index、core、controller、diagnostics、observer、delivery、structure。
- 提供本次真实预设路径运行测试：**118 项通过，0 失败，0 跳过**。
- 保留 1.2.1 的 98 项测试，增加 18 项交付/结构回归与 2 项控制器回归。
- Lin2.5、原始 Lin2.6、修订 Lin2.6 各验证 user / pair × normal / regenerate / swipe，共 18 次离线组装；输入请求和预设不被直接改写，其他消息保留。
- 修订预设逐字段比较，只改变 `prompts[65].content` 和 `prompts[82].content`；其余 JSON 值完全一致，尾部保护段落和正则保留。

## 回归覆盖

- 构造 5013 字符全为 Lin_CoT 注释、STOP、独立思考字段 0、生成用量 4081 的响应，识别“尚无正文”。
- UTF-8 分块、注释边界、注释加正文、文本内思考标签、组件闭合、围栏里的 HTML 例子、重复 Lin_CoT。
- SSE 无结束信号的 EOF；正常 DONE / finish reason / 原生结束事件；final message 快照不与 delta 重复累加。
- 无顶层名称的 Lin2.6、未知预设保守跳过、实际启用顺序、触发类型、关闭保护、幂等注入、user / pair 尾部检查。
- 当前已保存回复检查，不改聊天、不存原文、不发额外网络请求。
- STOP 和正数文本长度不掩盖结构警告；停止词仅提示，不擅自删除。

5013 字符案例是按日志形状构造的测试，不是恢复了失败轮原文，也不能证明该轮实际结构。

## 复跑

Node.js 20+，无额外依赖。先运行 `npm run check`，再指定附件位置：

```sh
LIN25_PRESET_PATH='/absolute/path/Lin2.5.json' \
LIN26_PRESET_PATH='/absolute/path/Lin2.6.json' \
LIN26_FIXED_PRESET_PATH='/absolute/path/Lin2.6-delivery-fix.json' \
npm test
```

未提供附件时，3 项真实预设测试明确跳过，其余可独立运行。个人预设不包含在插件包里。

## 限制

未进行用户渠道、实际酒馆/世界书完整组装、手机界面和显示正则的端到端测试，也未测量空回率。源文本结构检查不能代表浏览器最终可见文字或剧情完整性，任意自定义格式的分析文字可能无法分类。

没有自动重试、改写模型回复、删除聊天或导出 Cookie。观察读取响应副本，容量/时间上限只停止观察，不中止原请求。统计不能恢复历史原文。

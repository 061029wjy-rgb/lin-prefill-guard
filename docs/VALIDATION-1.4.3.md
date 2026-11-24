# 1.4.3 验收记录（2026-11-24）

测试了实际 SillyTavern 1.19.1（82b64a45c34facbc98ff4b9f33c067d3ccab6a17）前端、生成生命周期、消息保存及后端请求适配器。最后一跳是本机受控 HTTP 服务；没有向 Google、Vertex 或第三方云模型发送剧情或购买调用。协议对照的“接收端”均指这个服务。测试时安装到临时账户，未使用真实人物或聊天。

## 实际命令和计数

|检查|1.4.2 基线|1.4.3 候选|
|---|---|---|
|npm run check|20 个浏览器模块等，版本一致|22 个浏览器模块等，版本一致|
|npm test|403 项：344 通过，59 跳过，0 失败|476 项：417 通过，59 跳过，0 失败|
|npm run test:143|不适用|新增 73 项，73 通过；已包含在 476 内|
|npm run test:browser|原浏览器套件 46 项|同一套件 46 项|
|npm run test:st|16 个实际请求适配样例|同一套件 16 个样例|
|npm run test:acceptance|原版脚本：24 对旧模式、16 行原生比较，82 个生成 POST，24 次本机 Google 格式请求|新版脚本：182 个浏览器生成 POST，127 次本机 Google 格式请求，详见下表|

跳过项依赖其他旧版私有预设或历史日志；本次没提供的材料不计为通过。完整 stdout/stderr 在 evidence/v143/。测试之间有重叠，不将上述计数相加。运行环境：Node 24.22.3，npm 11.19.1，Chromium 133.0.6943.0，Python 3.12.14。

## 八轮证据

|轮次及对象|实际命令或样例|发现、处理与复测|
|---|---|---|
|1 固定版本和输入|SHA-256；逐文件对 Git 树；基线上先跑上表中的原命令|1.4.2 ZIP 与 119 个 Git 跟踪文件对应。记录基线和关键模块两版摘要于 env.json、base.json，源码不随远端分支漂移。|
|2 Lin 原文和启用状态|test:acceptance → literary；同一次宏展开与组装得到三个比较分支|两套顺序 100000 / 100001 启用 56 / 61 条。12 个不同场景各测两套，含短、中、长合成历史。逐项对角色和内容、整份请求正文及原生请求对象，旧版、新版关闭、新版标准+追踪一致。没有启用原先未选的 CoT。此项只确认输入，不评价文学质量。|
|3 新机制是否独立|test:143；test:acceptance → echoAB、randomCross；输出隔离样例|旧版/新版关闭的纯标记回显仍会在下一次重生成时出现。标准开启、已知正常结束、同题且手动尝试：模型形状接收端只少了独立标记，四组（两种后端 × 两种重试）其余字段和内容一致。没有第二种已经验证的深度策略，因此禁用深度档。工具/文字两种输出通道只在本地样例研究。|
|4 实际请求生命周期|test:143；test:acceptance → hostChatLifecycle、manualActionBytePairs、staleTargetExtraCalls|真实宿主 Generate(normal) 后，分别点重生成语义、走宿主 swipe_right：两例各发两次请求，第一次已保存模拟回显，手动尝试后 ST 保存了模拟正文。旧的手动续写/重生成入口另有两组字节比较；目标过时额外调用为 0。生成前暂停新功能曾会清掉旧样本复用/旧计划；拆开失效逻辑，原顺序重新测试通过。|
|5 协议与联网|test:st；test:acceptance → native、legacyMatrix、requestMimeAB|8 对真实 Google 适配器组合（后端 × 搜索 × 尾部顺序），另有 24 对旧模式包，旧路径一致。刻意漏掉请求类型的同一份 JSON：1.4.2 与新版关闭均返回 400、未到接收端；新版补齐类型后 200、接收端收到一次。同一正文没有改字节。已有正确/显式类型、签名/不明头、图像、工具、响应 Schema 另用反例验证跳过；不假装连通了真实第三方。|
|6 随机、响应与归因|test:143；randomCross 的 5 组开关；流式/非流式对照|原 nonce、旧样本、新追踪号可区分；新号在浏览器→酒馆可见，实际测试的酒馆没有把它转发给本地 Google 形状端。非流式 Google 结束原因可能在酒馆转换时消失：即使受控接收端返回 STOP，也报告“缺结束原因”，不建立回显凭据。仅 [DONE] / 长度 / 限制 / 半包 / 显式错误 / JSON 未知均有反例。没有真实缓存命中率或每项 token 费用。|
|7 手机、旧操作、升级|四个宽度；真实点按/键盘、完整宿主刷新；settingFieldChanges；已准备发送时暂停的回归|320/375/390/1100 CSS 像素无面板横向溢出；测得常用整行触控区至少 44px。原范围、注入方式、思考预算可点且保存。暂停只动 pause143，恢复运行原样还原。新版恢复默认、旧推荐和旧批量关闭的实际键差异分列；未知偏好和历史保留。桌面测键盘；没有把 Chromium 的模拟视口当成真实 iOS VoiceOver。|
|8 交付、隐私与回退|真实面板截图；复制按钮→读取剪贴板并校验白名单；打包器逐成员校验|默认分享不含编号、原始正文和内容指纹；实际示例 redacted-example.json。压缩包含完整前端、测试、截图及日志，与原版同一目录安装；备份放在宿主扩展扫描目录外，换回原目录即可回退。源码提交、基线与文件摘要分别见 BUILD.json / SHA256SUMS.txt。|

机器可读证据：[宿主比较结果](../evidence/v143/real-143.json)、[脱敏诊断样例](../evidence/v143/redacted-example.json)。不同协议绕过条件主要由可重复构造的反例验证，不等于每种路径都用真实服务测试过。部分 POST 专门用于检查回退、错误或兼容对照，不应当用 127 除以 182 推断成功率。

## 复现方法

在原版与新版各自独立目录运行。Python 需要 Playwright；CHROMIUM 指向可执行文件；测试要从本机启动已安装运行依赖的上述酒馆源码。LPG_BASELINE 必须为对应的旧版本树：运行 1.4.2 的旧宿主脚本时用 1.4.1，运行 1.4.3 时用 1.4.2。无需模型密钥。输出和临时目录放在源码树外。

~~~sh
export CHROMIUM=/path/to/chromium
export LPG_ST_PATH=/path/to/SillyTavern
export LIN290_PRESET=/path/to/original-lin-2.9.0.json
export LPG_BASELINE=/path/to/lin-prefill-guard-1.4.2
export LPG_EVIDENCE=/tmp/lin143-host-evidence
npm run check
npm test
npm run test:143
npm run test:browser
npm run test:st
npm run test:acceptance
~~~

可选：在启动宿主对照前指定 LPG_PRIVATE_DIGEST_DIR 为源码与证据目录以外、原先不存在的私有目录。会额外保存 24 组同次组装的逐消息摘要，不写聊天正文；这些摘要仍可能用于比对已知句子，故不放入安装包或默认分享。普通用户不需要启用。

**尚未验证：**真实 AI Studio / Vertex / 第三方转发服务的模型输出、模型完成率或路由，真实缓存和费用，12 组文学质量盲评，iPhone/VoiceOver、TauriTavern 及长期使用。输出通道原型未接入聊天；仅靠这份插件不能恢复模型未生成的字。

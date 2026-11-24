# 1.4.2 → 1.4.3：交接与改动清单

安装源为用户的 1.4.2 ZIP。两版的精确 Git 对应关系、源码树和 ZIP 校验规则见包根 BUILD.json 与 SHA256SUMS.txt。变更仅发生在本扩展。没有重新发布 Lin 预设，没有修改其他扩展。

|文件|改了什么；核对方法|
|---|---|
|shield-engine.js（新）|定义新版设置、同轮请求归属、受保护的请求结构、随机头长度与白名单、缺失 JSON 请求类型的修复，以及短时的同题回显凭据。数据不写入角色卡或聊天。|
|coordinator.js / controller.js|在原有一次出站管线中规划、核实并执行。旧设置与新版设置各有失效条件：发送途中改新版选项只撤销新版动作；不丢旧版已准备的发送计划、旧样本同题复用或旧被动备份。重生成/滑动的目标须能核实。|
|observer.js / wire-response.js / response-evidence.js（新）|只为相关回包建立本轮证据；区分正常终止、长度、限制、工具、通道显式错误、仅结束帧、空字节和未知。对 2.9.0 管理流按宿主读取速度观察；断开观察不会取消宿主读取。|
|core.js / transport.js|版本与新选项归一化，导出供新版复核的请求戳。旧设置不重置。未改变模型路由、参数、搜索和签名。|
|index.js / setting-help.js / style.css|按中文任务重排为一个面板；整行可点，分别写明何时开、开后做什么、何时跳过。新增暂停/重置与旧批量按钮分开，未知偏好继续保留。|
|current-result.js / diagnostics.js|拆开“已保存设置、实际发送、回包、上游不可证明”；当前轮和历史分开；安全复制只收白名单状态和数字。本版新记录的正文比对值只临时使用。|
|auxiliary.js / handoff.js / lin290.js / panel-controls.js / recovery.js|同步依赖模块的版本查询串，使升级后浏览器不会混载 1.4.2。原承接、旧样本格式、旧按钮和手动恢复的逻辑保留。|
|manifest.json / package.json|入口保持 index.js；两者版本升级；新增 test:143，test:acceptance 和 test:phone 指向本版宿主测试。旧版测试脚本保留，用对应版本的源码运行。|
|test/v143.test.js / scripts/host-143.mjs / scripts/verify-143.py|新增单元反例及真实酒馆浏览器→后端→本地接收端差分，保留原 403 项单测。包含真正发送、重生成、滑动及临时聊天保存，不只测试生成前内存对象。|
|scripts/lab-text-143.mjs|纯本地、只用于合成输入的文字输出定界原型；不接入正常聊天。|
|scripts/package-143.py|从已提交的完整 Git 树打包，包含源码、测试、原始日志及完整性清单；校验基线和压缩包内每个成员。|
|README.md / CHANGELOG.md / docs/SCOPE-1.4.3.md / docs/MECHANISMS-1.4.3.md / docs/VALIDATION-1.4.3.md / 本文件|使用说明、决定范围、兼容和证据边界、逐项验收及回退。|
|docs/images/v143/ / evidence/v143/|真实酒馆合成场景截图、基线/新版运行日志及不含私有消息的对照表。未发布原始预设、通信正文、随机编号或每条消息的指纹。|

若要继续开发，先在固定基线和同一版酒馆重跑 docs/VALIDATION-1.4.3.md 里的命令。旧版原文或新实验关闭时的序列化发生改变，先查发送协调器和同轮比对，再改界面。不要根据 HTTP 成功、STOP、[DONE] 或角色可见文本长度推断剧情是否完整。

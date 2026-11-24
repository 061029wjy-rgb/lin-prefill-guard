// A status code/text from the story itself is never an error envelope.
export function verdict(w,stopped=false){
    if(!w)return stopped?'client-stop':'unknown';
    if(w.httpStatus>=400&&w.httpStatus<=599)return 'http-error';
    if(w.apiError)return 'envelope-error';
    if(w.blockReason||/^(?:SAFETY|CONTENT_FILTER|RECITATION|PROHIBITED_CONTENT|BLOCKLIST|SPII|MODEL_ARMOR|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT)$/i.test(w.finishReason||''))return 'filtered';
    if(w.refusal)return 'refusal';
    if(stopped)return 'client-stop';
    if(w.aborted)return 'aborted';
    if(w.networkError)return 'network';
    if(w.captureLimited)return 'partial';
    if(w.parseErrors)return 'parse-error';
    if(!w.responseComplete)return 'unknown';
    if(w.protocolMismatch)return 'format-mismatch';
    if(w.finishReason?.toLowerCase()==='continuation')return 'continuation';
    if(/^(max_tokens|length)$/i.test(w.finishReason||''))return 'token-limit';
    if(w.toolCalls||/^(tool_calls|tool_use|function_call)$/i.test(w.finishReason||''))return 'tool';
    if(w.receivedBytes===0)return 'no-bytes';
    if(w.doneMarker&&w.nonDoneData===false)return 'done-only';
    if(/^(stop|stop_sequence|end_turn)$/i.test(w.finishReason||''))return 'stop';
    return 'unknown';
}
export const EVIDENCE=Object.freeze({unknown:'原因未知', 'http-error':'HTTP 返回错误','envelope-error':'响应体含明确错误字段',
    filtered:'接口明确报告内容限制',refusal:'接口明确标记拒答','client-stop':'酒馆报告停止，未区分手动与错误',
    aborted:'请求中止，原因未细分',network:'请求或读取失败',partial:'只读到部分报文','parse-error':'客户端诊断解析失败',
    'format-mismatch':'请求与回包格式不符',continuation:'接口报告还需续传','token-limit':'接口报告达到输出上限',tool:'接口返回工具调用',
    'no-bytes':'响应体确实为零字节','done-only':'只有流结束标志，没有正文帧',stop:'接口报告正常停写，正文是否写完未知'});
export const DECISIONS=Object.freeze({off:'关闭',paused:'本版实验已暂停',ready:'已规划，等待发送',scope:'不在本轮适用范围',indirect:'自定义渠道未验证',
    search:'保留搜索，本版实验跳过',protected:'工具、签名、预填充或其他受保护结构',shape:'请求结构未验证',unverified:'发送与规划不一致或请求头受保护',
    inconclusive:'回包不足以证明正常纯回显，后续不调整', 'not-echo':'本轮并非只返回插件标记，重试照旧','end-unverified':'只看到了标记，接口未提供结束原因，重试照旧', monitoring:'等待完整回包核对标记','no-question':'无法锁定同一角色与用户问题','no-aux':'原设置本轮不产生插件标记',
    'echo-confirmed':'已确认回包只有本插件标记；同题下一次手动重试可避开',omitted:'本次手动重试未再添加上次被照抄的插件辅助区',
    unchanged:'已有正确类型，未修改',added:'已补缺失的 JSON 请求类型',explicit:'已有明确的请求类型，原样保留',
    'native-skip':'原生封装不改浏览器请求头',occupied:'已有同名请求头，未覆盖',unavailable:'无法取得合格随机数',sent:'浏览器已发送随机锚',
    ambiguous:'多次发送，不能认领单一回包',rollback:'验证失败，回退','unowned-marker':'已有不属于本轮的标记，未删除或改写',
    conflict:'同轮出现冲突',expired:'规划过期','changed-input':'发送内容改变','changed-chat':'聊天已切换','changed-options':'设置改变',
    'wire-guard':'无法无损核对','request-object':'非宿主字符串请求','too-large':'超过本地容量','random-unavailable':'安全随机不可用',unknown:'未核实'});
export const ACKS=Object.freeze({none:'没有发送或尚无回包',matched:'返回头与本轮一致',absent:'未回传编号（多数酒馆如此）',mismatch:'回包编号不符；本插件不采用该回复作证或备份',unknown:'未核实'});

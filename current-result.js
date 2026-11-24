import {verdict,DECISIONS,ACKS} from './response-evidence.js?v=1.4.3';
import {TRANSPORT_LABELS} from './transport.js?v=1.4.3';
const known=(value,options,fallback='unknown')=>options.includes(value)?value:fallback;
const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const statusList=['off','owned-slot','no-independent-slot','unowned-marker','random-unavailable','wire-guard','raw-guard','changed-input','changed-options','changed-chat','conflict','expired','duplicate','no-ticket','request-object','too-large','unavailable','no-lifecycle','290-host-search','tools','structured','290-shape','290-special','290-postprocess','g4-uncertain','g4-other','g4-continue','native-prefill','observe-only','disabled','290-layout','290-ready','290-restored','290-unknown','g4-disabled','quiet','impersonate','trigger-excluded'];
// Export by allowlist. Never include record IDs, text, sample, hashes, endpoints, MIME from the network, or provider errors.
export function shareResult(last){
    const e=last?.experiment,w=last?.wire;
    return {schema:2,version:'1.4.3',sourceVersion:typeof last?.version==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(last.version)?last.version:null,record:!!last,profile:known(e?.profile,['off','standard']),source:known(last?.request?.source,['makersuite','vertexai','custom']),
        type:known(last?.type,['normal','regenerate','swipe','continue','quiet','impersonate']),status:known(e?.status,statusList),
        observed:e?.browserSent===true,receipt:e?.httpReceipt===true,upstreamVerified:false,
        transport:known(e?.transport,Object.keys(TRANSPORT_LABELS)),search:typeof e?.search==='boolean'?e.search:null,
        echo:typeof w?.sampleEcho==='boolean'?w.sampleEcho:null,cue:known(e?.bodyStrategy,['none','legacy-tail','search-tail']),sampleChars:count(e?.randomChars),bodyDeltaBytes:count(e?.addedBytes),
        run:e?.v143?{guard:known(e.v143.guard,Object.keys(DECISIONS)),mime:known(e.v143.mime,Object.keys(DECISIONS)),anchor:known(e.v143.anchor,Object.keys(DECISIONS)),chars:count(e.v143.chars),ack:known(e.v143.ack,Object.keys(ACKS)),traceInText:typeof w?.traceInText==='boolean'?w.traceInText:null}:null,
        response:w?{kind:verdict(w,last?.clientStopped),reportedError:w.apiError?count(w.apiStatus):null,wholeInputTokens:count(w.promptTokens),wholeOutputTokens:count(w.outputTokens),http:count(w.httpStatus),complete:w.responseComplete===true,done:w.doneMarker===true,finish:known(String(w.finishReason||'').toLowerCase(),['stop','end_turn','stop_sequence','max_tokens','length','continuation','tool_calls','content_filter','safety']),wireBytes:count(w.receivedBytes)}:null};
}
export function currentResult(state,last,pending){
    if(!state.enabled)return '扩展已关闭。设置和诊断都保留；下一条消息不会按插件设置处理。';
    if(pending||!last)return '仅保存设置，还没看到下一次生成请求。照常发送一条消息，这里会显示实际结果。';
    const e=last.experiment;if(!e)return '最近一轮走的是原有处理模式。实际承接和返回结果见下方「诊断与补全」。';
    if(!e.browserSent)return ['changed-input','conflict','changed-chat','changed-options','expired','request-object','too-large'].includes(e.status)?
        '发送与组装未能对应，本轮实验未核实；请看下方诊断。':'已看到组装，尚未核对到同一轮的浏览器发送。';
    if(e.v143?.ack==='mismatch')return '酒馆已回包，但和这次发送的编号不符。本插件不采信这份回包；酒馆显示的原文未改。';
    if(e.v143?.guard==='omitted')return '同题手动重试：这次没有再添加上次被原样照抄的插件标记。其他 Lin 文本保留。'+(e.httpReceipt?'酒馆已回包。':'尚未看到回包。');
    const run=e.v143||{};
    const extra=[run.mime==='added'?'已补 JSON 请求类型':'',run.anchor==='sent'?'已发给酒馆本轮追踪号':'',
        run.guard==='echo-confirmed'?'已确认本轮只返回插件标记，手动重试可省略它':'',
        run.guard==='end-unverified'?'接口未给结束原因，回显保护没有采取动作':'',
        e.search&&[run.guard,run.anchor,run.mime].includes('search')?'保留网页搜索，本版新实验跳过':''].filter(Boolean).join('；');
    const header=TRANSPORT_LABELS[e.transport]||'未核实接收格式';
    const cue=e.repair?'已调回两条原承接的顺序':e.status==='off'||e.status==='owned-slot'?'已核对原承接，顺序无需调整':'未报告承接调整';
    if(e.status==='wire-guard'||e.status==='random-unavailable'||e.status==='raw-guard'||e.transport==='raw-guard'||e.transport==='rollback')return '本轮实验回退：'+(e.transport==='raw-guard'||e.status==='wire-guard'?'出站格式无法无损核对':e.status==='random-unavailable'?'无法取得随机样本':'无法安全设置接收格式')+'。已放行请求；'+cue+'。';
    if(e.status==='unowned-marker'||e.search&&e.status==='290-host-search'||['tools','structured','290-shape','290-special','290-postprocess','native-prefill','g4-continue','observe-only','disabled','g4-other','g4-uncertain','g4-disabled','290-layout','290-unknown'].includes(e.status)){
        const why=e.transport?.startsWith('protected-')?header:e.status==='290-host-search'?'本轮含 Google 网页搜索，没有启用或不满足搜索兼容条件':e.status==='unowned-marker'?'已有来源不明的实验标记':e.status==='tools'?'已有工具或工具回包':e.status==='structured'?'要求结构化输出':e.status==='observe-only'?'选择了原样诊断':e.status==='g4-continue'?'手动继续沿用酒馆原流程':header==='已关闭'?'未满足本轮处理条件':header;
        return '本轮请求实验已跳过：'+why+'。插件保留当前设置；本轮承接以详细诊断为准。';
    }
    const sample=e.randomChars>0?'已加入旧样本编号':e.search?'网页搜索保留':e.sampleSkipped?'同题旧样本不能核实，已跳过':'未附加旧样本编号';
    return '已核对浏览器发送：'+header+'；'+cue+'；'+sample+'。'+(extra?extra+'。':'')+(e.httpReceipt?'酒馆已回包。':'尚未观察到酒馆回包。');
}
export function resetRecommendations(s){Object.assign(s,{protocolProfile:'off',macro:false,experimentDetails:false});return s;}

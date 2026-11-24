import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createController } from '../controller.js';
import { googleThinkingStatus, formatRecord } from '../diagnostics.js';
import { inspectResponse } from '../observer.js';
import { LIN_PROMPT_ID, LIN_CONFIRM_ID } from '../gemini4.js';
import { NPC291 } from '../lin291.js';

const msg = (role, content) => ({role, content});
const entries = [
    {identifier:NPC291, ...msg('system', '街坊也有自己的安排。')},
    {identifier:LIN_PROMPT_ID, ...msg('assistant', '延续眼前的场景。')},
    {identifier:LIN_CONFIRM_ID, ...msg('user', '接着写。\n【生成交接】\n保留当前视角。')},
];
const preset = () => ({
    name:'Lin 2.9.1', prompts:structuredClone(entries), show_thoughts:false, reasoning_effort:'low',
    prompt_order:[{character_id:100001, order:entries.map(e=>({identifier:e.identifier,enabled:true}))}],
});
const request = (p, opts={}) => ({
    messages:[msg('user','今天天气怎么样？'), ...[LIN_PROMPT_ID, LIN_CONFIRM_ID].map(id=>{
        const {role,content} = p.prompts.find(e=>e.identifier===id);
        return msg(role,content);
    })],
    type:'normal', chat_completion_source:'vertexai', model:'gemini-4-carbon',
    stream:true, max_tokens:16384, include_reasoning:false, reasoning_effort:'low', ...opts,
});
function hooked(p, state={requestMode:'gemini4'}, order=100001, respond) {
    const events = new Map();
    const ctx = {chat:[], chatCompletionSettings:p, eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
        eventSource:{on:(e,fn)=>events.set(e,fn), removeListener:()=>{}}};
    const net = {location:{href:'http://localhost/'}, fetch:respond || (async()=>new Response('{}'))};
    const ctl = createController({getContext:()=>ctx, getSettings:()=>state, getOrderId:()=>order, networkTarget:net});
    return {ctl, net, run:r=>events.get('ready')(r)};
}
for (const source of ['vertexai','makersuite']) {
    for (const model of ['gemini-4-carbon','gemini-4-argon']) {
        test('verified low settings complete standard generation types on '+source+' / '+model, ()=>{
            const p=preset(), h=hooked(p);
            try {
                for (const type of ['normal','regenerate','swipe','continue']) {
                    const r=request(p,{model,type,chat_completion_source:source});
                    const before=structuredClone(r), messages=r.messages;
                    h.run(r);h.run(r);
                    assert.equal(r.messages,messages);
                    assert.deepEqual(r,{...before,lin_gemini4_low_thinking:true});
                    assert.equal(h.ctl.snapshot().last.request.includeReasoning,false);
                    assert.equal(h.ctl.snapshot().last.request.lowThinkingRequested,true);
                }
            } finally {h.ctl.dispose();}
        });
    }
}
test('explicit selection, mode, provider and protected request fields control forwarding', ()=>{
    const cases=[
        {r:{reasoning_effort:'auto'}}, {r:{include_reasoning:true}}, {r:{include_reasoning:undefined}},
        {p:{show_thoughts:true}}, {p:{reasoning_effort:'high'}}, {s:{enabled:false}}, {s:{requestMode:'observe'}},
        {r:{reverse_proxy:'http://localhost/'}},{r:{chat_completion_source:'custom'}},
        {r:{model:'proxy/gemini-4-carbon'}},{r:{model:'Gemini-4-Carbon'}},{r:{vertexai_auth_mode:'proxy'}},
        {r:{model:'gemini-4-neon'}},{r:{model:'gemini-3-pro'}},
        {r:{type:'quiet'}},{r:{type:'impersonate'}},{r:{assistant_prefill:'一个段落'}},
        {r:{tools:[{type:'function'}]}},{r:{json_schema:{}}},{r:{n:2}},
        {r:{messages:[msg('user','仅有历史')]}}, {r:{type:'continue',messages:[msg('assistant','保留原断点')]}},
        {p:{name:'Lin 2.9.0'}},
    ];
    for (const c of cases) {
        const p=Object.assign(preset(),c.p), h=hooked(p,{requestMode:'gemini4',...c.s});
        try {
            const r=request(p,c.r), before=structuredClone(r);
            h.run(r);
            assert.deepEqual(r,before);
        } finally {h.ctl.dispose();}
    }
});
test('inactive preset prefill field cannot prevent repairing a direct Google tail', ()=>{
    const p=preset();p.assistant_prefill='仅限另一个接口的可见前缀';
    const h=hooked(p);
    try {
        const r=request(p), expected=[...r.messages];
        r.messages=[expected[0],expected[2],expected[1]];
        h.run(r);
        assert.deepEqual(r.messages,expected);
        assert.equal(h.ctl.snapshot().last.reason,'g291-restored');
        r.messages.at(-2).prefix=true;h.run(r);
        assert.equal(h.ctl.snapshot().last.reason,'g291-unsupported-prefix');
        assert.equal('lin_gemini4_low_thinking' in r,false);
    } finally {h.ctl.dispose();}
});
test('an explicitly changed setting, disabled mode or read-only payload cannot inherit a forwarding decision', ()=>{
    const p=preset(), state={requestMode:'gemini4-story'}, h=hooked(p,state);
    try {
        const r=request(p);r.messages=[r.messages[0],r.messages[2],r.messages[1]];h.run(r);
        assert.equal(r.lin_gemini4_low_thinking,true);h.run(r);
        r.reasoning_effort='high';h.run(r);assert.equal('lin_gemini4_low_thinking' in r,false);
        r.reasoning_effort='low';h.run(r);assert.equal(r.lin_gemini4_low_thinking,true);
        state.requestMode='observe';h.run(r);assert.equal('lin_gemini4_low_thinking' in r,false);
        state.requestMode='gemini4';const frozen=Object.freeze(request(p));h.run(frozen);
        assert.equal(h.ctl.snapshot().last.reason,'g291-ready');
        assert.equal('lin_gemini4_low_thinking' in frozen,false);
    } finally {h.ctl.dispose();}
});
test('browser observes a backend acknowledgement only when received on the correlated response', async()=>{
    for (const receipt of ['low-no-summary','unknown',null]) {
        const p=preset();
        const h=hooked(p,undefined,100001,async()=>new Response(JSON.stringify({
            candidates:[{content:{parts:[{text:'完成。'}]},finishReason:'STOP'}],usageMetadata:{thoughtsTokenCount:83,candidatesTokenCount:3}
        }),{headers:{'content-type':'application/json',...(receipt ? {'X-Lin-Gemini-Thinking':receipt} : {})}}));
        try {
            const r=request(p);h.run(r);
            await h.net.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(r)});
            await h.ctl.idle();const rec=h.ctl.snapshot().last;
            assert.equal(rec.dispatch.request.lowThinkingRequested,true);
            assert.equal(rec.wire.hostLowThinking===true,receipt==='low-no-summary');
            const report=googleThinkingStatus(rec);
            assert.match(report,/浏览器发送档位 low，返回摘要关/);
            assert.match(report,receipt==='low-no-summary'?/后端已组装 LOW/:/未收到酒馆后端回执/);
            assert.match(report,/83 token，原生摘要 0 字符/);
            assert.ok(!formatRecord(rec).includes(p.prompts[2].content));
        } finally {h.ctl.dispose();}
    }
});
test('ST non-streaming thought summaries do not double count visible text or reveal the summary',async()=>{
    const secret='示例摘要', visible='月亮升起。';
    for(const reasoning of [undefined,'',secret]){
        const data={choices:[{message:{content:visible,reasoning_content:reasoning}}],responseContent:{parts:[
            {text:secret,thought:true},{text:visible,thoughtSignature:'opaque-only'}]}};
        const stats=await inspectResponse(new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}));
        assert.equal(stats.reasoningChars,secret.length);assert.equal(stats.visibleChars,visible.length);
        assert.ok(!JSON.stringify(stats).includes(secret));assert.equal(stats.thoughtTokens,undefined);
    }
});
const files=[process.env.LIN291_EDITED_PRESET,process.env.LIN291_LOW_PRESET];
test('complete importable Lin preset has a distinct import name and changes exactly two generation settings', {skip:!files.every(Boolean)},()=>{
    const [old,p]=files.map(f=>JSON.parse(readFileSync(f,'utf8')));
    assert.equal(old.show_thoughts,true);assert.equal(old.reasoning_effort,'auto');
    assert.equal(p.name,'Lin-2.9.1-低思考');
    assert.deepEqual(p,{...old,name:p.name,show_thoughts:false,reasoning_effort:'low'});
    assert.equal(p.prompts.length,93);assert.equal(p.extensions.regex_scripts.length,19);
    for(const g of p.prompt_order) {
        const h=hooked(p,undefined,g.character_id);
        try {const r=request(p);h.run(r);assert.equal(h.ctl.snapshot().last.reason,'g291-ready');
            assert.equal(r.lin_gemini4_low_thinking,true);assert.equal(r.messages.at(-1).role,'user');}
        finally{h.ctl.dispose();}
    }
});
test('uploaded 1.3.1 Carbon diagnosis keeps tokens, native summary and authored block distinct',
    {skip:!process.env.LIN131_DIAGNOSTIC},()=>{
    const rows=JSON.parse(readFileSync(process.env.LIN131_DIAGNOSTIC,'utf8')).records
        .filter(r=>r.version==='1.3.1' && r.dispatch?.correlation==='exact' && r.request?.model==='gemini-4-carbon');
    assert.equal(rows.length,1);const [r]=rows;
    assert.equal(r.dispatch.linOrder,'cue-before-user');assert.equal(r.lin291.closureEnabled,true);
    assert.equal(r.rendered.reasoningChars,0);assert.equal(r.wire.finishReason,'STOP');
    assert.match(googleThinkingStatus(r),/2053 token，原生摘要 0 字符，正文内 Lin_CoT 914 字符/);
});

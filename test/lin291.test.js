import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {planInjection, migrateSettings, VERSION} from '../core.js';
import {identify291, layout291, NPC291} from '../lin291.js';
import {LIN_PROMPT_ID as C, LIN_CONFIRM_ID as U, orderProof} from '../gemini4.js';
import {ACK} from '../handoff.js';
import {createController} from '../controller.js';
import {auditPreset,formatRecord,recordStatus} from '../diagnostics.js';

const m=(role,content)=>({role,content});
const g=(id,enabled=true)=>({identifier:id,enabled});
const oldSample=()=>({
    name:'lin2.9.1', enable_web_search:true,
    prompts:[{identifier:NPC291,...m('system','旁人也有自己的安排。'),enabled:false},{identifier:C,...m('assistant','请接上当前用户的问题。')},{identifier:U,...m('user','保留本轮所有原约束。\n\n按当前任务答复。')}],
    prompt_order:[{character_id:100000,order:[g(NPC291,false),g(C),g(U)]},{character_id:100001,order:[g(NPC291),g(C),g(U)]}],
});
const actual=process.env.LIN291_PRESET,old=process.env.LIN282_PRESET;
const req=(p,rev=false)=>{const exact=id=>{const e=p.prompts.find(x=>x.identifier===id);return m(e.role,e.content);};
    const pair=[exact(C),exact(U)];if(rev)pair.reverse();
    return {type:'normal',chat_completion_source:'vertexai',model:'gemini-4-carbon',stream:true,enable_web_search:true,n:1,
        max_tokens:16384,reasoning_effort:'auto',messages:[m('system','适用的角色及场景背景。'),m('user','看看院子里的鸟。'),...pair]};};
const go=(r,p,mode='gemini4',activeOrderId=100001,opt={})=>planInjection(r,{requestMode:mode,...opt},{preset:p,activeOrderId});
const sha=b=>createHash('sha256').update(b).digest('hex');

for(const model of ['argon','carbon','hydrogen','neon']) for(const type of ['normal','regenerate','swipe']){
    test('2.9.1 '+model+' '+type+': original tail is untouched; reversed tail changes only order',()=>{
        const p=oldSample(),a=req(p),b=req(p,true);
        for(const r of [a,b]){r.type=type;r.model='gemini-4-'+model;}
        const baseline=JSON.stringify(p);const good=go(a,p),fixed=go(b,p);
        assert.equal(good.messages,a.messages);assert.equal(good.changed,false);assert.equal(good.reason,'g291-ready');
        assert.equal(fixed.reason,'g291-restored');assert.equal(fixed.netChars,0);assert.equal(fixed.messages.at(-1),b.messages.at(-2));
        assert.equal(fixed.messages.at(-2),b.messages.at(-1));assert.equal(fixed.messages[1],b.messages[1]);
        assert.deepEqual({...a,messages:fixed.messages},a);assert.equal(fixed.injected.length,0);assert.equal(JSON.stringify(p),baseline);
        assert.equal(orderProof(fixed.messages,fixed.orderWitness),'cue-before-user');
        assert.equal(orderProof([...fixed.messages,m('user','新的真实补充')],fixed.orderWitness),'unknown');
    });
}
test('two active-order groups have separate NPC switches and never borrow an enabled anchor',()=>{
    const p=oldSample(),r=req(p,true);assert.equal(go(r,p,'gemini4',100000).lin291.npcEnabled,false);
    assert.equal(go(r,p,'gemini4',100001).lin291.npcEnabled,true);
    assert.deepEqual(go(r,p,'gemini4',null).lin291,{identity:'title-and-entry',path:'original',order:'consensus',cueEnabled:true,confirmEnabled:true,npcEnabled:null});
    p.prompt_order[0].order[1].enabled=false;
    assert.equal(go(r,p,'gemini4',null).reason,'g291-order');assert.equal(go(r,p,'gemini4',100000).changed,false);assert.equal(go(r,p,'gemini4',100001).changed,true);
    assert.equal(go(r,p,'gemini4',999).reason,'g291-order');
    p.prompt_order.push(structuredClone(p.prompt_order[1]));assert.equal(go(r,p,'gemini4',100001).reason,'g291-order');
});
test('user-specific trigger, original role, independent markers and complete unchanged text are required',()=>{
    for(const edit of [
        p=>p.prompts.find(e=>e.identifier===C).injection_trigger=['swipe'],
        p=>p.prompts.find(e=>e.identifier===C).role='system',
        p=>p.prompts.find(e=>e.identifier===U).injection_position=1,
        p=>p.prompts.find(e=>e.identifier===U).content+='自己的新设置',
        p=>p.prompts.push(structuredClone(p.prompts[1])),
        p=>p.prompt_order[1].order.reverse(),
        p=>{p.prompts.push({identifier:'t',...m('system','用户的另一个结尾。')});p.prompt_order[1].order.push(g('t'));},
    ]){const p=oldSample(),r=req(p,true);edit(p);const z=go(r,p,'gemini4-story');assert.equal(z.changed,false);assert.equal(z.messages,r.messages);assert.ok(!z.handoff);}
});
test('both IDs alone, a filename alone, adjacent 2.9.0 / 2.9.10, or conflicting labels are not 2.9.1',()=>{
    for(const nm of ['lin2.9.0','lin2.9.10','lin2.9.10beta','lin2.9.1rc1','lin2.8.2','lin3.0']){
        const p=oldSample();p.name=nm;assert.equal(identify291(p),'conflict');assert.equal(go(req(p,true),p,'gemini4-story').changed,false);
    }
    const p=oldSample();p.preset_settings_openai='Lin2.8.2';assert.equal(identify291(p),'conflict');
    delete p.preset_settings_openai;p.prompts=p.prompts.filter(x=>x.identifier!==NPC291);
    assert.equal(identify291(p),'conflict');p.name='别的预设';assert.equal(identify291(p),null);
});
test('customized anchor content is preserved when it matches both preset and wire, including one text block',()=>{
    const p=oldSample();p.prompts[2].content+='\n修订：角色仍可沉默。';const r=req(p);
    const confirm=r.messages.at(-1);confirm.content=[{type:'text',text:confirm.content}];
    const a=go(r,p,'gemini4-story');assert.equal(a.reason,'g291-handoff');assert.equal(a.messages.at(-3),confirm);
    assert.equal(a.messages.at(-2),r.messages.at(-2));assert.deepEqual(a.messages.at(-1),m('user',ACK));
    assert.equal(a.injected.length,1);assert.equal(a.netChars,ACK.length);assert.equal(a.handoff.removedMaxDemand,false);
});
test('the original 1.3 short confirmation is opt-in on direct Vertex, including its exact cap option',()=>{
    const p=oldSample(), r=req(p);
    for (const mode of ['gemini4','observe','enhance']){const a=go(r,p,mode,100001,{storyMoreTokens:true});assert.equal(a.messages,r.messages);assert.equal(a.handoff,undefined);}
    for(const opt of [false,true]){
        const z=go(r,p,'gemini4-story',100001,{storyMoreTokens:opt});
        assert.equal(z.handoff.cap?.after??null,opt?32768:null);assert.equal(z.messages.length,r.messages.length+1);
        assert.equal(orderProof(z.messages,z.orderWitness),'cue-before-user');
        assert.equal(orderProof(z.messages.filter(x=>x!==r.messages.at(-1)),z.orderWitness),'unknown');
        assert.equal(go({...r,messages:z.messages},p,'gemini4-story').changed,false);
    }
    for(const patch of [{reverse_proxy:'local-proxy'},{model:'AISTUDIO-gemini-4-carbon'},{chat_completion_source:'custom'},{chat_completion_source:'makersuite'},{max_completion_tokens:12000}]){
        const z=go({...r,...patch},p,'gemini4-story');assert.equal(z.messages,r.messages);assert.equal(z.handoff,undefined);
    }
    assert.equal(go({...r,model:'gemini-4-carbonate'},p).reason,'g4-other');
    assert.equal(go({...r,max_tokens:8192},p,'gemini4-story',100001,{storyMoreTokens:true}).handoff.cap,null);
    assert.equal(go({...r,chat_completion_source:'openai',model:'DeepSeek-V4.1-Flash-1017'},p,'enhance').changed,false);
});
test('new compatibility will not move existing replies, split merged anchors or treat quoted prompts as ownership',()=>{
    for(const alter of [
        a=>a.push(m('assistant','普通故事')),
        a=>a.splice(-1,0,m('system','未知的系统备注')),
        a=>{a.at(-1).content+='\n和一条普通消息合并';},
        a=>a.unshift(m('user','引用：'+a.at(-2).content)),
        a=>a.unshift(m('system',a.at(-1).content)),
        a=>{a.at(-1).name='Player';},a=>a.splice(1,1),
    ]){const p=oldSample(),r=req(p,true);alter(r.messages);const z=go(r,p,'gemini4-story');assert.equal(z.messages,r.messages);assert.equal(z.changed,false);}
    const p=oldSample(),r=req(p);r.messages.unshift(m('user',ACK));assert.equal(go(r,p,'gemini4-story').handoff,undefined);
});
const protectedCases=[
    ['continue',{type:'continue'}],['quiet',{type:'quiet'}],['impersonate',{type:'impersonate'}],
    ['native prefix',{assistant_prefill:'指定开头'}],['multiple candidates',{n:2}],['tools',{tools:[{type:'function',function:{name:'f'}}]}],
    ['functions',{functions:[{name:'f'}]}],['MCP',{mcp_servers:[{}]}],['schema',{json_schema:{}}],['JSON mode',{response_format:{type:'json_object'}}],
    ['continuation',{continuationToken:'reference'}],['cached',{cached_content:'reference'}],
    ['thought signature',m('assistant',[{type:'text',text:'片段',thoughtSignature:'reference'}])],
    ['history tool',{role:'tool',content:'历史工具结果'}],['image',m('user',[{type:'image_url',image_url:{url:'about:blank'}}])],
];
for(const [name,patch] of protectedCases)test('cannot modify '+name+' in 2.9.1',()=>{
    const p=oldSample(),r=req(p,true);if(patch.role)r.messages.unshift(patch);else Object.assign(r,patch);
    const b=JSON.stringify(r);const z=go(r,p,'gemini4-story');assert.equal(z.changed,false);assert.ok(!z.handoff);
    assert.equal(JSON.stringify(r),b);
});
test('local diagnosis distinguishes settings from dispatch, old 1.3.0 history is not relabeled, search can stay on',()=>{
    const p=oldSample(),r=req(p);const z=go(r,p);
    const fmt=formatRecord({version:VERSION,at:'local',id:'1',requestMode:'gemini4',...z,messages:undefined});
    assert.match(fmt,/Lin 2.9.1/);assert.match(fmt,/NPC 优化 开/);assert.match(fmt,/未观察到浏览器发送/);
    assert.doesNotMatch(fmt,/Lin 2.8.2 ×/);assert.equal(recordStatus(z).label,'已核对·保持原样');
    assert.match(formatRecord({version:'1.3.0',id:'2',at:'then',reason:'g4-not-lin282',requestMode:'gemini4'}),/Lin 2.8.2/);
    assert.match(auditPreset(p,r,{requestMode:'gemini4'},100000).join(' '),/不要求关闭/);
    assert.deepEqual(migrateSettings({requestMode:'observe',unknown:11}).unknown,11);
});
test('actual event and fetch boundary: same-object reentry, mixed legacy preferences, companion front note and no double request',async()=>{
    const p=oldSample(),note=m('system','〔人性阴暗面/情绪/随机性放大·角色演出〕 测试信息');
    for(const mode of ['gemini4','enhance','gemini4-story']){
        const bus=new Map(),store=new Map(),ctx={chat:[],chatCompletionSettings:p,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'r'},eventSource:{on:(k,v)=>bus.set(k,v),removeListener(){}},accountStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};
        let sent, count=0;const net={location:{href:'http://localhost/'},fetch:async(u,i)=>{count++;sent=JSON.parse(i.body);return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}};
        const ctl=createController({getContext:()=>ctx,getOrderId:()=>100000,getSettings:()=>({requestMode:mode,storyMoreTokens:true,reasoningMode:'balanced'}),networkTarget:net});
        try{
            const r=req(p,true);r.model='gemini-4-argon';r.reasoning_effort='high';const snap=JSON.stringify(p);
            bus.get('r')(r);const a=r.messages;bus.get('r')(r);assert.equal(r.messages,a);assert.equal(r.reasoning_effort,'high');
            r.messages.splice(1,0,note);await net.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(r)});await ctl.idle();
            const rec=ctl.snapshot().last;assert.equal(rec.version,VERSION);assert.equal(rec.reason,mode==='gemini4-story'?'g291-handoff':'g291-restored');
            assert.equal(rec.dispatch.linOrder,'cue-before-user');assert.equal(rec.dispatch.correlation,'companion-front-note');
            assert.equal(rec.lin291.npcEnabled,false);assert.equal(rec.adjustment,null);assert.equal(count,1);
            assert.equal(sent.enable_web_search,true);assert.equal(sent.max_tokens,mode==='gemini4-story'?32768:16384);assert.equal(JSON.stringify(p),snap);
            assert.ok(!JSON.stringify(rec).includes(p.prompts[2].content));assert.ok(!JSON.stringify(rec).includes(note.content));assert.equal(ctx.chat.length,0);
        }finally{ctl.dispose();}
    }
});
test('uploaded, byte-pinned Lin 2.9.1: full file, both orders, renamed host profile, NPC disabled in one order, enabled in the other', {skip:!actual},()=>{
    const b=readFileSync(actual),p=JSON.parse(b),h='79425364f929723df789af37ddd9f9806db9e845ee14e27a4f919de8683c4f70';
    assert.equal(sha(b),h);assert.equal(p.prompts.length,93);
    for(const [id,count,npc] of [[100000,55,false],[100001,61,true]]){
        const ord=p.prompt_order.find(x=>x.character_id===id);assert.equal(ord.order.filter(x=>x.enabled).length,count);
        for(const renamed of [false,true]){
            const s=structuredClone(p);if(renamed){delete s.name;s.preset_settings_openai='我的测试副本';}
            assert.equal(identify291(s),renamed?'preset-entries':'title-and-entry');
            const base=req(s), r=go(base,s,'gemini4',id),l=layout291(s,'normal',id);
            assert.equal(r.reason,'g291-ready');assert.equal(r.lin291.npcEnabled,npc);assert.equal([...l.confirm.content].length,1258);assert.equal(l.confirm.content,base.messages.at(-1).content);
            const h=go(base,s,'gemini4-story',id);assert.equal(h.messages.at(-3),base.messages.at(-1));
            assert.equal(h.messages.at(-2),base.messages.at(-2));assert.equal(h.handoff.removedMaxDemand,false);
            s.prompt_order.find(x=>x.character_id===id).order.find(x=>x.identifier===NPC291).enabled=!npc;
            assert.equal(go(base,s,'gemini4',id).lin291.npcEnabled,!npc);
        }
    }
    assert.equal(sha(readFileSync(actual)),h);
});
test('uploaded Lin 2.8.2 still uses the 1.3 path for its own maximum-thinking paragraph', {skip:!old},()=>{
    const p=JSON.parse(readFileSync(old));assert.equal(identify291(p),null);
    const z=go(req(p),p,'gemini4-story');assert.equal(z.reason,'g4-handoff');assert.equal(z.handoff.removedMaxDemand,true);assert.equal(z.lin291,undefined);
});

for(const type of ['normal','regenerate','swipe'])test('user-authored final handoff stays the final full user object, once: '+type,()=>{
    const p=oldSample(),u=p.prompts.find(x=>x.identifier===U);
    u.content+='\r\n\r\n  【生成交接】 \r\n仅供本轮使用的自定义结尾 A。\r\n第二段仍属于同一条消息。';
    for(const rev of [false,true])for(const mode of ['gemini4','gemini4-story','enhance','observe']){
        const r=req(p,rev);r.type=type;const orig=structuredClone(r),u0=r.messages.find(x=>x.content===u.content),a0=r.messages.find(x=>x.content===p.prompts[1].content);
        const z=go(r,p,mode,100001,{storyMoreTokens:true});
        assert.deepEqual(r,orig);assert.equal(z.injected.length,0);assert.equal(z.netChars,0);
        if(mode==='observe'){assert.equal(z.messages,r.messages);continue;}
        assert.equal(z.messages.at(-1),u0);assert.equal(z.messages.at(-2),a0);assert.equal(z.messages.length,r.messages.length);
        assert.equal(z.messages.filter(m=>m.content===u.content).length,1);assert.ok(!z.messages.some(m=>m.content===ACK));
        if(!rev)assert.equal(z.messages,r.messages);
        assert.equal(orderProof(z.messages,z.orderWitness),'cue-before-user');
        if(mode==='gemini4-story'){
            assert.equal(z.reason,rev?'g291-authored-restored':'g291-authored-ready');
            assert.equal(z.handoff.cap?.after,32768);assert.equal(z.handoff.shortConfirmation,false);
        } else assert.equal(z.handoff,undefined);
    }
});
test('the marker is read only from the verified preset turn, never inferred from ordinary chat or embedded quotations',()=>{
    const p=oldSample();p.prompts[2].content+='\n玩家提到了“【生成交接】”这个名字。';
    const r=req(p);r.messages[1].content+='\n【生成交接】\n这是普通用户文本。';
    assert.equal(go(r,p,'gemini4-story').reason,'g291-handoff');
    p.prompts[2].content+='\n【生成交接】\n新尾部。'; // actual request still has old content
    assert.equal(go(r,p,'gemini4-story').reason,'g291-anchors');assert.equal(go(r,p,'gemini4-story').messages,r.messages);
    const cur=req(p);cur.tools=[{type:'function',function:{name:'test'}}];
    assert.equal(go(cur,p,'gemini4-story').reason,'tools');assert.equal(go(cur,p,'gemini4-story').messages,cur.messages);
});
test('edited tail and opt-in budget-only on repeated settings event: exact metadata, no silent extra request or generic ACK',async()=>{
    const p=oldSample();p.prompts[2].content+='\n【生成交接】\n这是用户写的新收尾。';
    const bus=new Map(),store=new Map(),ctx={chat:[],chatCompletionSettings:p,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'r'},eventSource:{on:(k,v)=>bus.set(k,v),removeListener(){}},accountStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};
    const net={location:{href:'http://localhost/'},fetch:async()=>new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})};
    const ctl=createController({getContext:()=>ctx,getOrderId:()=>100001,getSettings:()=>({requestMode:'gemini4-story',storyMoreTokens:true}),networkTarget:net});
    try{
        const r=req(p),msg=r.messages;bus.get('r')(r);bus.get('r')(r);
        assert.equal(r.max_tokens,32768);assert.equal(r.messages,msg);assert.equal(r.reasoning_effort,'auto');
        await net.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(r)});await ctl.idle();
        const rec=ctl.snapshot().last;assert.equal(rec.dispatch.linOrder,'cue-before-user');assert.equal(rec.handoff.cap.after,32768);
        const report=formatRecord(rec);assert.match(report,/没有追加插件短确认/);assert.ok(!report.includes(p.prompts[2].content));assert.equal(rec.injected.length,0);
        const readonly=req(p);Object.defineProperty(readonly,'max_tokens',{value:16384,writable:false});
        bus.get('r')(readonly);assert.equal(readonly.max_tokens,16384);assert.equal(ctl.snapshot().last.applied,false);
    }finally{ctl.dispose();}
});
const edited=process.env.LIN291_EDITED_PRESET;
test('uploaded edited export: exactly one changed prompt, order 100001 removed two disabled options, closure off, no other changes',{
    skip:!actual||!edited
},()=>{
    const oldBytes=readFileSync(actual),bytes=readFileSync(edited),p=JSON.parse(bytes),orig=JSON.parse(oldBytes);
    assert.equal(sha(bytes),'2cdd746b2e6e2a1197c51e010fdacdd1db750e5eaede1c9a7237fcc78ee7e2e8');
    const closure='99dd9277-7d27-40fb-972f-a009ae4983e9';
    assert.equal(p.prompts.length,93);assert.deepEqual(p.prompts.map(x=>x.identifier),orig.prompts.map(x=>x.identifier));
    assert.deepEqual(p.prompts.filter(x=>x.identifier!==U),orig.prompts.filter(x=>x.identifier!==U));
    const ignore=({prompts,prompt_order,...rest})=>rest;
    assert.deepEqual(ignore(orig),ignore(p));
    const u=p.prompts.find(x=>x.identifier===U);assert.equal([...u.content].length,1324);
    assert.match(u.content,/^【生成交接】$/m);
    assert.deepEqual({...u,content:''},{...orig.prompts.find(x=>x.identifier===U),content:''});
    for(const [id,count,npc] of [[100000,55,false],[100001,60,true]]){
        const ord=p.prompt_order.find(x=>x.character_id===id).order,oldOrder=orig.prompt_order.find(x=>x.character_id===id).order;
        const removed=oldOrder.filter(x=>!ord.some(y=>y.identifier===x.identifier));
        assert.equal(removed.length,id===100001?2:0);assert.ok(removed.every(x=>!x.enabled));
        assert.deepEqual(ord,oldOrder.filter(x=>!removed.includes(x)).map(x=>x.identifier===closure?{...x,enabled:false}:x));
        assert.equal(ord.filter(e=>e.enabled).length,count);
        for(const renamed of [false,true]){
            const s=structuredClone(p);if(renamed){delete s.name;s.preset_settings_openai='我改过的测试副本';}
            const r=req(s),z=go(r,s,'gemini4-story',id);
            assert.equal(z.reason,'g291-authored-ready');assert.equal(z.messages,r.messages);assert.equal(z.handoff.cap,null);
            assert.equal(z.lin291.closureEnabled,false);assert.equal(z.lin291.npcEnabled,npc);assert.equal(z.lin291.authoredHandoff,true);
            assert.equal(z.messages.at(-1).content,u.content);assert.ok(!z.injected.length);
            assert.equal(go(req(orig),s,'gemini4-story',id).changed,false);
        }
    }
    assert.equal(sha(readFileSync(edited)),sha(bytes));
});

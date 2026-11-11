import test from 'node:test';
import assert from 'node:assert/strict';
import { planInjection, migrateSettings, DEFAULTS, LIN_PROMPT_ID } from '../core.js';
import { gemini4Target, lin282Layout, LIN_CONFIRM_ID, orderProof } from '../gemini4.js';
import { createController } from '../controller.js';
import { createRecovery } from '../recovery.js';
import { inspectResponse } from '../observer.js';
import { recordStatus, formatRecord } from '../diagnostics.js';

const m = (role, content) => ({ role, content });
const instruction = '从花园里继续。', confirmation = '写本轮的场景。';
const middle = m('system', '场景格式。'), end = m('system', '版式提示。');
const q = m('user', '树开花了。'), a = m('assistant', instruction), u = m('user', confirmation);
const preset = () => {
    const prompts = [{ identifier:LIN_PROMPT_ID, ...a }, { identifier:'middle', ...middle },
        { identifier:LIN_CONFIRM_ID, ...u }, { identifier:'end', ...end }];
    return { name:'Lin2.8.2', prompts, prompt_order:[{character_id:100001,
        order:prompts.map(p => ({ identifier:p.identifier, enabled:true }))}] };
};
const req = (messages, model='gemini-4-argon', source='vertexai', type='normal') =>
    ({ messages, model, chat_completion_source:source, type, stream:true, max_tokens:16384,
        stop:['FIN'], enable_web_search:true, reasoning_effort:'auto' });
const settings = { requestMode:'gemini4', scope:'all', mode:'pair', reasoningMode:'balanced' };
const plan = (r, p=preset()) => planInjection(r, settings, {preset:p});

for (const model of ['gemini-4-argon','gemini-4-carbon']) for (const type of ['normal','swipe','regenerate']) {
    test(model + ' ' + type + ': restore one misplaced preset object without altering its contents or any other message', () => {
        const p = preset(), good=[q,a,middle,u,end], bad=[q,middle,u,end,a];
        const r=req(bad,model,'vertexai',type), original=structuredClone(r);
        const fixed=plan(r,p); assert.equal(fixed.reason,'g4-restored');
        assert.deepEqual(fixed.messages,good); good.forEach((x,i)=>assert.equal(x,fixed.messages[i]));
        assert.equal(fixed.netChars,0); assert.deepEqual(fixed.injected,[]); assert.deepEqual(r,original);
        assert.equal(orderProof(fixed.messages,fixed.orderWitness),'cue-before-user');
        const rerun=plan({...r,messages:fixed.messages},p);
        assert.equal(rerun.reason,'g4-ready'); assert.equal(rerun.messages,fixed.messages);
    });
}
test('two anchors only are sufficient when optional parts are absent; plain text blocks retain their byte content',()=>{
    const block = m('assistant',[{type:'text',text:instruction}]);
    const r=req([q,u,block],'gemini-4-carbon','makersuite'), fixed=plan(r);
    assert.equal(fixed.reason,'g4-restored'); assert.equal(fixed.messages[1],block);
    assert.equal(fixed.messages[2],u);
});
test('an empty trailing placeholder is not a valid user turn; preserve it and all existing object identities',()=>{
    const empty=m('user','  '), r=req([q,u,a,empty]), fixed=plan(r);
    assert.equal(fixed.reason,'g4-restored'); assert.equal(fixed.messages.at(-1),empty);
    assert.deepEqual(fixed.messages.slice(0,-1),[q,a,u]);
});
test('matches only the two specified models and connection types; channel aliases do not certify the backend',()=>{
    for (const [model,source,indirect] of [['gemini-4-carbon','vertexai',false],['AISTUDIO-gemini-4-argon','custom',true],
        ['gemini-4-carbon/fc','custom',true],['gemini-4-argon/vs','custom',true]]) {
        assert.equal(gemini4Target(req([],model,source)).indirect,indirect);
    }
    for (const [model,source] of [['gemini-4-carbonate','vertexai'],['gemini-4-carbon-preview','vertexai'],
        ['gemini-4-carbon/gemini-4-argon','custom'],['gemini-4-carbon','deepseek'],['gemini-3.8-flash','makersuite']]) {
        const r=req([q,u,a],model,source); assert.equal(plan(r).reason,'g4-other'); assert.equal(plan(r).messages,r.messages);
    }
});
test('protected jobs, other versions, disabled prompts, missing anchors and ambiguous matches are unchanged',()=>{
    const cases = [
        [ {type:'continue'}, null, 'g4-continue' ],[ {type:'quiet'},null,'quiet' ],[ {type:'impersonate'},null,'impersonate' ],
        [ {tools:[{}]},null,'tools' ],[ {messages:[q,m('tool','ok'),u,a]},null,'tools' ],[ {mcp_servers:[{}]},null,'tools' ],
        [ {json_schema:{}},null,'structured' ],[ {response_format:{type:'json_object'}},null,'structured' ],
        [ {assistant_prefill:'手工前缀'},null,'native-prefill' ],[ {messages:[q,u,{...a,prefix:true}]},null,'native-prefill' ],
        [ {},p=>{p.prompt_order[0].order[0].enabled=false;},'g4-disabled'],
        [ {},p=>{p.prompts[0].injection_trigger=['swipe'];},'trigger-excluded'],
        [ {},p=>{p.name='Lin2.6.2';},'g4-not-lin282' ],
        [ {},p=>{delete p.name;},'g4-not-lin282'],
        [ {messages:[q,u,{...a,signature:'signed'}]},null,'g4-uncertain' ],
        [ {messages:[q,u,m('assistant',instruction+'\n故事')]},null,'g4-uncertain' ],
        [ {messages:[q,a,u,a]},null,'g4-uncertain' ],[ {messages:[q,u,q,a]},null,'g4-uncertain' ],
        [ {messages:[q,u,m('system','其他插件的后记'),a]},null,'g4-uncertain' ],
        [ {messages:[q,m('system','合并段\n'+middle.content),u,a]},null,'g4-uncertain' ],
        [ {messages:[q,a,u,m('assistant','已经存在的故事')]},null,'g4-foreign-tail' ],
    ];
    for(const [change,edit,expected] of cases){
        const r={...req([q,u,a]),...change}, p=preset(); edit?.(p);
        const before=JSON.stringify([r,p]), res=plan(r,p);
        assert.equal(res.reason,expected); assert.equal(res.changed,false); assert.equal(JSON.stringify([r,p]),before);
    }
});
test('new installations select the targeted adapter; old modes remain explicit choices',()=>{
    assert.equal(migrateSettings().requestMode,'gemini4'); assert.equal(DEFAULTS.requestMode,'gemini4');
    for(const requestMode of ['observe','enhance','gemini4']) assert.equal(migrateSettings({requestMode}).requestMode,requestMode);
    assert.equal(migrateSettings({mode:'pair'}).requestMode,'observe');
    assert.equal(lin282Layout(preset()).confirm.identifier,LIN_CONFIRM_ID);
});
test('controller serializes the repaired order exactly once; verifies the actual browser dispatch without storing cue or chat', async()=>{
    const bus=new Map(), ctx={ chat:[],chatCompletionSettings:preset(),eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'request'},
        eventSource:{on:(k,v)=>bus.set(k,v),removeListener:k=>bus.delete(k)} };
    let calls=0, sent;
    const response=new Response(JSON.stringify({choices:[{message:{content:'树荫。'},finish_reason:'stop'}]}));
    const net={ location:{href:'http://localhost/'},fetch:async(_url,init)=>{calls++;sent=JSON.parse(init.body);return response;} };
    const c=createController({getContext:()=>ctx,getSettings:()=>settings,networkTarget:net});
    try {
        const r=req([q,middle,u,end,a]), p=JSON.stringify(ctx.chatCompletionSettings);
        const rest={...r}; delete rest.messages;
        bus.get('request')(r);
        assert.equal(c.snapshot().last.reason,'g4-restored');
        const returned=await net.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(r)});
        assert.equal(returned,response); await c.idle(); assert.equal(calls,1);
        assert.deepEqual(sent,{...rest,messages:[q,a,middle,u,end]});
        const record=c.snapshot().last; assert.equal(record.dispatch.linOrder,'cue-before-user');
        assert.equal(record.dispatch.verified,false); assert.deepEqual(record.injected,[]);
        assert.equal(record.adjustment,null); assert.equal(JSON.stringify(ctx.chatCompletionSettings),p);
        assert.deepEqual(ctx.chat,[]); assert.ok(!JSON.stringify(record).includes(instruction)); assert.ok(!JSON.stringify(record).includes(q.content));
    } finally {c.dispose();}
});
test('provider continuation is distinct from a stop or a restriction; no raw token is stored and the local recovery action sends no request',async()=>{
    const secret='private-segment-value';
    const body=JSON.stringify({candidates:[{content:{parts:[{text:'上半段'}]},finishReason:'CONTINUATION',continuationToken:secret}]});
    const w=await inspectResponse(new Response(body,{headers:{'content-type':'application/json'}}));
    const r={gemini4:gemini4Target(req([])),wire:w}, msg={mes:'上半段'};let calls=0;
    const recovery=createRecovery({getContext:()=>({chat:[msg],mainApi:'openai',generate:()=>{calls++;}}),getRecord:()=>r});
    assert.equal(w.continuationTokenSeen,true);assert.equal(recordStatus(r).label,'上游要求续传');
    assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!formatRecord(r).includes(secret));
    assert.equal(recovery.prepare().ok,false);assert.equal(calls,0);
    w.finishReason='STOP'; assert.equal(recovery.prepare().ok,true);
    w.finishReason='content_filter'; assert.equal(recovery.prepare().ok,false);
});

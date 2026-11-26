import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {planInjection} from '../core.js';
import {createController} from '../controller.js';
import {formatRecord} from '../diagnostics.js';
import {LIN_PROMPT_ID as C, LIN_CONFIRM_ID as U, NPC291} from '../protocol.js';
import {orderProof} from '../gemini4.js';

const message = (role,content) => ({role,content});
const row = identifier => ({identifier,enabled:true});
const plain = () => ({
    prompts:[{identifier:C,...message('assistant','本轮交给用户确认。')},
        {identifier:U,...message('user','【生成交接】\n完整保留原确认。')}],
    prompt_order:[{character_id:100001,order:[row(C),row(U)]}],
});
const request = messages => ({type:'normal',model:'gemini-4-carbon',chat_completion_source:'vertexai',
    stream:true,max_tokens:16384,n:1,enable_web_search:true,messages});
const plan = (p,r,mode='gemini4',id=100001,opts={}) =>
    planInjection(r,{requestMode:mode,...opts},{preset:p,activeOrderId:id});

// Use all enabled prompt definitions from the chosen export. A real chat turn stands in for
// the host's chatHistory marker. This fixture intentionally does not expand ST macros.
function assemble(p,id) {
    const prompts = new Map(p.prompts.map(e => [e.identifier,e]));
    const ms = [], user = message('user','今天在窗边看到了什么？');
    for (const e of p.prompt_order.find(g => g.character_id === id).order) {
        if (!e.enabled) continue;
        if (e.identifier === 'chatHistory') { ms.push(user); continue; }
        const d = prompts.get(e.identifier);
        if (d && !d.marker && d.content?.trim() && !d.injection_position) ms.push(message(d.role,d.content));
    }
    if (!ms.includes(user)) ms.unshift(user);
    return ms;
}
function reversePair(ms) { return [...ms.slice(0,-2),ms.at(-1),ms.at(-2)]; }
function checkPair(p,id,mode,type,reversed) {
    const original = assemble(p,id);
    const raw = reversed ? reversePair(original) : original;
    const q = {...request(raw),type};
    const result = plan(p,q,mode,id), observing = mode === 'observe';
    assert.equal(result.protocol,'pair');
    assert.equal(result.reason, observing ? 'observe-only' : mode === 'gemini4-story' ?
        (reversed ? 'g291-authored-restored' : 'g291-authored-ready') : (reversed ? 'g291-restored' : 'g291-ready'));
    assert.equal(result.changed,reversed && !observing);
    if (result.changed) original.forEach((m,i) => assert.equal(result.messages[i],m));
    else assert.equal(result.messages,raw);
    assert.equal(result.messages.length,raw.length);
    assert.equal(result.injected.length,0);
    assert.equal(result.netChars,0);
    assert.equal(orderProof(result.messages,result.orderWitness),observing && reversed ? 'out-of-order' : 'cue-before-user');
    assert.equal(q.messages,raw);
}

const real = [
    ['LIN293_PRESET','2.9.3','7da9e45a595788fc437e53bf2a472caa5a2cb203caec4bacc40b6abdf043c35c'],
    ['LIN293_FY_PRESET','2.9.3 FY','efb07cf125baacda56ff9fc821beaa63c18e7e2a61fd3a5ba67f94cc9cc95c46'],
    ['LIN293_DERIVED_PRESET','2.9.3 derived'],
    ['LIN291_LOW_PRESET','2.9.1 low','c7f28593dcb37d40c7967b8cc7c2056aa1641fe532755b57c8422a80ed36fba5'],
];
for (const [env,label,digest] of real) test(label+' authentic export: both groups, modes, generated types and both orders',
    {skip:!process.env[env]}, async t => {
        const file = process.env[env], bytes = readFileSync(file), p = JSON.parse(bytes);
        if (digest) assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
        const snapshot = JSON.stringify(p);
        for (const id of [100000,100001]) await t.test('prompt order '+id,() => {
            for (const mode of ['gemini4','gemini4-story','observe','enhance'])
                for (const type of ['normal','regenerate','swipe'])
                    for (const rev of [false,true]) checkPair(p,id,mode,type,rev);
        });
        assert.equal(JSON.stringify(p),snapshot);
        assert.deepEqual(readFileSync(file),bytes);
    });

test('future derivative uses current text and order after renaming, replacing NPC / CoT and rewriting ordinary entries',
    {skip:!process.env.LIN293_PRESET}, () => {
        const p = JSON.parse(readFileSync(process.env.LIN293_PRESET));
        p.name = '塔版 · 自订'; p.preset_settings_openai = 'Lin 18.7-preview';
        p.prompts = p.prompts.filter(d => d.identifier !== NPC291);
        for (const g of p.prompt_order) g.order = g.order.filter(e => e.identifier !== NPC291);
        for (const d of p.prompts) {
            d.name = '自订条目';
            if (d.content?.trim() && ![C,U].includes(d.identifier)) d.content = '新版规则 ' + d.identifier;
        }
        p.prompts.find(d => d.identifier === C).content += '\n自定义承接。';
        p.prompts.find(d => d.identifier === U).content += '\n自定义交付说明。';
        for (const id of [100000,100001]) for (const mode of ['gemini4','gemini4-story','observe','enhance'])
            for (const rev of [false,true]) checkPair(p,id,mode,'normal',rev);
    });

test('a third-party export stays unverified even with Lin labels and the exact two outgoing texts',
    {skip:!process.env.LIN_OTHER_PRESET}, () => {
        const p = JSON.parse(readFileSync(process.env.LIN_OTHER_PRESET));
        p.name = 'Lin 2.9.3'; p.preset_settings_openai = 'Lin 2.9.1';
        const q = request(reversePair(assemble(plain(),100001)));
        for (const mode of ['gemini4','gemini4-story']) {
            const z = plan(p,q,mode);
            assert.equal(z.protocol,'unknown');assert.equal(z.messages,q.messages);assert.equal(z.applied,false);
            assert.match(z.detail,/缺失/);
        }
    });

test('ambiguous groups cannot authorize an edit, including in explicit legacy enhancement',() => {
    const p=plain(), valid=request(reversePair(assemble(p,100001)));
    const other=structuredClone(p.prompt_order[0]);other.character_id=100000;other.order[1].enabled=false;
    p.prompt_order.unshift(other);
    for (const mode of ['gemini4','gemini4-story','enhance','observe']) {
        const z=plan(p,valid,mode,null,{scope:'all'});
        assert.equal(z.changed,false);assert.equal(z.protocol,'unknown');assert.match(z.detail,/各组不一致/);
    }
    assert.equal(plan(p,valid,'gemini4',100001).reason,'g291-restored');
    assert.equal(plan(p,valid,'gemini4',100000).reason,'g4-disabled');
});

test('static preflight names the failed definition, switch, order, trigger or foreign tail',() => {
    const cases = [
        [p=>p.prompts.pop(),/确认定义缺失/], [p=>p.prompts.push(p.prompts[0]),/承接定义重复/],
        [p=>p.prompts[1].role='assistant',/确认角色应为 user/], [p=>p.prompts[0].marker=true,/占位符/],
        [p=>p.prompts[0].injection_trigger=['swipe'],/生成类型/], [p=>p.prompt_order[0].order.reverse(),/排在/],
        [p=>p.prompt_order[0].order[1].enabled=false,/确认.*关闭/],
        [p=>p.prompt_order[0].order.push(row('missing-definition')),/定义不明确/],
    ];
    for (const [edit,why] of cases) {
        const p=plain(), q=request(reversePair(assemble(p,100001)));edit(p);
        const z=plan(p,q,'gemini4-story');
        assert.equal(z.protocol,'unknown');assert.equal(z.messages,q.messages);assert.match(z.detail,why);
    }
});

test('matching static configuration cannot override wrong-role, merged, quoted or displaced wire text',() => {
    const p=plain(), ms=assemble(p,100001), [user,cue,confirm]=ms;
    const cases=[
        [[user,cue],/确认原文未出现/], [[user,cue,message('assistant',confirm.content)],/错误的消息角色/],
        [[user,cue,message('user',confirm.content+'附注')],/已合并/],
        [[user,cue,confirm,message('user','另一条真实用户消息')],/末尾两个位置/],
        [[message('user',[{type:'text',text:cue.content.slice(0,3)},{type:'text',text:cue.content.slice(3)}]),...ms],/多条消息/],
        [[user,message('assistant',[{type:'text',text:cue.content.slice(0,3)},{type:'text',text:cue.content.slice(3)}]),confirm],/多个文本块/],
    ];
    for (const [messages,why] of cases) for (const mode of ['gemini4','gemini4-story','observe','enhance']) {
        const q=request(messages), z=plan(p,q,mode);
        assert.equal(z.protocol,'pair');assert.equal(z.messages,messages);assert.equal(z.changed,false);assert.match(z.detail,why);
    }
});

test('valid protocol protects parallel envelopes, native candidate counts and signed / multimodal history',() => {
    const p=plain(), ms=reversePair(assemble(p,100001));
    for (const [patch,why] of [[{input:[]},'parallel-input'],[{contents:[]},'parallel-input'],
        [{generationConfig:{candidateCount:2}},'multiple-candidates'],[{cachedContent:'cache'},'continuation-or-cache'],
        [{messages:[message('user',[{type:'image_url',image_url:{url:'about:blank'}}]),...ms]},'g291-protected'],
        [{messages:[{role:'assistant',content:'字段',thoughtSignature:'x'},...ms]},'g291-protected']]) {
        const q={...request(ms),...patch}, z=plan(p,q,'gemini4-story');
        assert.equal(z.reason,why);assert.equal(z.messages,q.messages);assert.equal(z.applied,false);
    }
});

test('a replay after a preset edit cannot reuse the old short-confirmation or low-thinking proof',() => {
    const p=plain();p.prompts[1].content='未加小节的旧规则。';p.show_thoughts=false;p.reasoning_effort='low';
    const listeners=new Map(), ctx={chat:[],chatCompletionSettings:p,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
        eventSource:{on:(e,fn)=>listeners.set(e,fn),removeListener:()=>{}}};
    const ctl=createController({getContext:()=>ctx,getOrderId:()=>100001,getSettings:()=>({requestMode:'gemini4-story'}),
        networkTarget:{}});
    try {
        const q={...request(assemble(p,100001)),include_reasoning:false,reasoning_effort:'low'};
        listeners.get('ready')(q);assert.equal(q.lin_gemini4_low_thinking,true);const sent=q.messages;
        p.prompts[1].content+='新原文。';listeners.get('ready')(q);assert.equal(q.messages,sent);
        assert.equal(q.lin_gemini4_low_thinking,undefined);
        const last=ctl.snapshot().last;assert.equal(last.reason,'g291-anchors');assert.match(last.explanation,/原文未出现/);
        assert.match(formatRecord(last),/独立双尾承接/);assert.ok(!JSON.stringify(last).includes(p.prompts[1].content));
    } finally {ctl.dispose();}
});

test('a final standalone output directive protects an edited handoff heading, including Vertex story mode',()=>{
    const p=plain();
    p.prompts[1].content='【自订规则】\r\n<final_output_directive>\r\n保留当前约束。\r\n</final_output_directive>';
    const q=request(reversePair(assemble(p,100001)));
    const z=plan(p,q,'gemini4-story');
    assert.equal(z.reason,'g291-authored-restored');assert.equal(z.injected.length,0);
    assert.equal(z.messages.at(-1),q.messages.at(-2));
    p.prompts[1].content='这里提到 <final_output_directive> 的写法。';
    assert.equal(plan(p,request(assemble(p,100001)),'gemini4-story').reason,'g291-handoff');
});

test('actual preset exports at the settings event and fetch boundary: exactly one HTTP request per send',
    {skip:!process.env.LIN293_PRESET || !process.env.LIN293_FY_PRESET},async t => {
        const bodies=[];
        const server=createServer(async(req,res)=>{
            const chunks=[];for await(const piece of req) chunks.push(piece);
            bodies.push(JSON.parse(Buffer.concat(chunks)));
            res.writeHead(200,{'content-type':'application/json'});
            res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'完成。'},finish_reason:'stop'}]}));
        });
        server.listen(0,'127.0.0.1');await once(server,'listening');
        t.after(()=>new Promise(done=>server.close(done)));
        const url='http://127.0.0.1:'+server.address().port+'/api/backends/chat-completions/generate';
        for (const env of ['LIN293_PRESET','LIN293_FY_PRESET']) {
            const p=JSON.parse(readFileSync(process.env[env])), listeners=new Map();
            let activeId=100001;
            const settings={requestMode:'gemini4',captureNetwork:true};
            const ctx={chat:[],chatCompletionSettings:p,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
                eventSource:{on:(key,fn)=>listeners.set(key,fn),removeListener:key=>listeners.delete(key)}};
            const net={location:{href:url},fetch};
            const ctl=createController({getContext:()=>ctx,getOrderId:()=>activeId,getSettings:()=>settings,networkTarget:net});
            try {
                for (activeId of [100000,100001]) for (const [mode,rev,alter,type,reason] of [
                    ['gemini4',false,false,'normal','g291-ready'],['gemini4',true,false,'regenerate','g291-restored'],
                    ['gemini4-story',true,false,'swipe','g291-authored-restored'],['observe',true,false,'normal','observe-only'],
                    ['enhance',true,false,'normal','g291-restored'],['gemini4',true,true,'normal','g291-anchors']]) {
                    const ms=assemble(p,activeId), initial=rev ? reversePair(ms) : ms;
                    if(alter) initial.unshift(message('system','历史引用 '+ms.at(-2).content));
                    const q={...request(initial),type,stream:false,include_reasoning:p.show_thoughts,reasoning_effort:p.reasoning_effort};
                    const expected={...q,messages:mode==='observe'||alter?initial:ms};
                    const count=bodies.length;settings.requestMode=mode;
                    listeners.get('ready')(q);listeners.get('ready')(q);
                    await (await net.fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q)})).text();
                    await ctl.idle();
                    assert.deepEqual(bodies.at(-1),expected);assert.equal(bodies.length,count+1);
                    const rec=ctl.snapshot().last;assert.equal(rec.reason,reason);assert.equal(rec.protocol,'pair');
                    assert.equal(rec.lin291.order,String(activeId));assert.equal(rec.dispatch.correlation,'exact');
                    assert.equal(rec.dispatch.linOrder,alter?undefined:mode==='observe'?'out-of-order':'cue-before-user');
                    assert.equal(rec.wire.finishReason.toUpperCase(),'STOP');assert.deepEqual(rec.injected,[]);
                    assert.ok(!JSON.stringify(rec).includes(ms.at(-1).content));
                }
            } finally {ctl.dispose();}
        }
        assert.equal(bodies.length,24);
    });

test('the packaged UI entry point reports a matched layout, conflicting group switches and missing definitions',
    {skip:!process.env.LIN293_FY_PRESET},async t=>{
        // Only the DOM / ST globals are doubles. index.js mounts its normal panel and binds its own buttons.
        class Element {
            constructor(tagName) { this.tagName=tagName;this.children=[];this.dataset={};this.events={};this.value='';this.className='';this.textContent=''; }
            append(...children){this.children.push(...children);}
            replaceChildren(...children){this.children=children;}
            setAttribute(k,v){this[k]=v;}
            addEventListener(k,v){this.events[k]=v;}
            remove(){}
            querySelector(selector){
                const cls=selector.match(/^\.([\w-]+)$/)?.[1], key=selector.match(/^\[data-setting="([^"]+)"\]$/)?.[1];
                return this.find(node=>cls ? node.className?.split(' ').includes(cls) : key && node.dataset?.setting===key);
            }
            find(test){for(const node of this.children){if(typeof node!=='object')continue;if(test(node))return node;const nested=node.find(test);if(nested)return nested;}return null;}
        }
        const host=new Element('div'), p=JSON.parse(readFileSync(process.env.LIN293_FY_PRESET));
        p.chat_completion_source='vertexai';
        const events=new Map(), ctx={chat:[],chatCompletionSettings:p,extensionSettings:{},eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
            eventSource:{on:(k,v)=>events.set(k,v),removeListener:k=>events.delete(k)},getChatCompletionModel:()=>'gemini-4-carbon',
            accountStorage:{getItem:()=>null,setItem(){}},saveSettingsDebounced(){}};
        const previous={SillyTavern:globalThis.SillyTavern,document:globalThis.document};
        globalThis.document={querySelector:k=>k==='#extensions_settings2'?host:null,getElementById:()=>null,createElement:tag=>new Element(tag)};
        globalThis.SillyTavern={getContext:()=>ctx};
        let ui;
        t.after(()=>{ui?.onDisable();for(const [k,v] of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}});
        ui=await import('../index.js');
        const button=host.find(n=>n.tagName==='button' && n.textContent.includes('本地自检'));
        assert.ok(button);const result=host.querySelector('.lpg-selftest');assert.ok(result);
        button.events.click();assert.match(result.textContent,/已识别 Lin 独立双尾承接/);
        const confirm=p.prompt_order[1].order.find(e=>e.identifier===U);confirm.enabled=false;
        button.events.click();assert.match(result.textContent,/未确认承接协议.*各组不一致/);
        confirm.enabled=true;p.prompts=p.prompts.filter(e=>e.identifier!==U);
        button.events.click();assert.match(result.textContent,/确认定义缺失/);
        assert.equal(events.has('ready'),true);
    });

for (const env of ['LIN282_R1_PRESET','LIN282_REPAIRED_PRESET']) test(env+' renamed; exact optional system messages remain in configured order',
    {skip:!process.env[env]},()=>{
        const bytes=readFileSync(process.env[env]),p=JSON.parse(bytes);
        p.name='新版塔';p.preset_settings_openai='Lin 3.0';
        for (const id of [100000,100001]) {
            const ms=assemble(p,id),ai=ms.findIndex(m=>m.content===p.prompts.find(d=>d.identifier===C).content);
            const q=request([...ms.slice(0,ai),...ms.slice(ai+1),ms[ai]]), compat=plan(p,q,'gemini4',id);
            assert.equal(compat.protocol,'ordered');assert.equal(compat.reason,'g4-restored');
            assert.deepEqual(compat.messages,ms);assert.deepEqual(compat.injected,[]);
            const story=plan(p,q,'gemini4-story',id);
            assert.equal(story.reason,'g4-handoff');assert.equal(story.handoff.removedMaxDemand,true);
            assert.equal(story.injected.length,1);assert.equal(orderProof(story.messages,story.orderWitness),'cue-before-user');
        }
        assert.deepEqual(readFileSync(process.env[env]),bytes);
    });

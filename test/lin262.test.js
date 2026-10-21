import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { deliveryProfile, deliveryCue, COT_ID, COT_VARIANTS } from '../delivery.js';
import { planInjection, LIN_PROMPT_ID, LIN_24_PREFILL, DEFAULTS } from '../core.js';
import { auditPreset, formatRecord, recordStatus, responseDiagnosis } from '../diagnostics.js';
import { analyzeOutput, structureDiagnosis } from '../structure.js';
import { inspectResponse } from '../observer.js';

const synthetic = () => {
    const prompts = [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: LIN_24_PREFILL },
        ...COT_VARIANTS.map(v => ({ identifier: v.id, role: 'system', enabled: false,
            content: '本条将Lin2.6实际启用的规则汇总。\n<!-- Lin_CoT:\n01｜任务：[结论]\n02｜交付：[结论]\n-->' }))];
    return { prompts, prompt_order: [{ character_id: 100001, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] };
};
const disableAll = p => { p.prompt_order[0].order.forEach(x => { if (COT_VARIANTS.some(v => v.id === x.identifier)) x.enabled = false; }); return p; };
for (const variant of COT_VARIANTS) test(`CoT activation follows order, not stale enabled flag: ${variant.label}`, () => {
    const p = disableAll(synthetic());
    p.prompt_order[0].order.find(x => x.identifier === variant.id).enabled = true;
    const profile = deliveryProfile(p);
    assert.equal(profile.cotEnabled, true);
    assert.deepEqual(profile.cotSources, [{identifier:variant.id,variant:variant.label,columns:2}]);
    assert.equal(profile.cotConflict, false);
    assert.match(deliveryCue(profile), /戏外讨论、纯摘要请求不追加/);
    assert.match(deliveryCue(profile), /正文原有篇幅要求不变/);
});
test('all three disabled stays conditional and does not force a fresh CoT', () => {
    const profile = deliveryProfile(disableAll(synthetic()));
    assert.equal(profile.cotEnabled, false); assert.deepEqual(profile.cotSources, []);
    assert.doesNotMatch(deliveryCue(profile), /500汉字|保留原有栏目/);
});
test('three enabled gives a conflict warning without rewriting any switch', () => {
    const p = synthetic(), before = JSON.stringify(p);
    assert.equal(deliveryProfile(p).cotSources.length, 3);
    assert.match(auditPreset(p).join('\n'), /同时启用了 3 套/);
    assert.equal(JSON.stringify(p), before);
});
test('CoT triggers and absent order are respected for all variants', () => {
    const p = synthetic(); p.prompts.slice(1).forEach(x => x.injection_trigger = ['swipe']);
    assert.equal(deliveryProfile(p, 'normal').cotEnabled, false);
    assert.equal(deliveryProfile(p, 'swipe').cotSources.length, 3);
    delete p.prompt_order;
    assert.equal(deliveryProfile(p).cotEnabled, false);
    assert.equal(deliveryCue(deliveryProfile(p)), '');
});
test('known empty CoT and arbitrary name do not create a new output requirement', () => {
    const p = synthetic();p.prompts.slice(1).forEach(x=>x.content='');
    p.prompts.push({identifier:'fake',role:'system',name:'Lin CoT',content:'Some unrelated text.'});
    p.prompt_order[0].order.push({identifier:'fake',enabled:true});
    assert.equal(deliveryProfile(p).cotEnabled, false);
});
test('compatible copied CoT needs both family and actual format signature', () => {
    const p=disableAll(synthetic());
    p.prompts.push({...p.prompts[1],identifier:'copied'});
    p.prompt_order[0].order.push({identifier:'copied',enabled:true});
    assert.equal(deliveryProfile(p).cotSources[0].variant,'兼容CoT');
    assert.ok(!JSON.stringify(deliveryProfile(p)).includes('Some unrelated'));
});
test('diagnostic export names the actual medium CoT and its evidence boundary', () => {
    const p=disableAll(synthetic());p.prompt_order[0].order.find(x=>x.identifier===COT_VARIANTS[1].id).enabled=true;
    const text=formatRecord({id:'test',deliveryProfile:deliveryProfile(p),deliveryGuard:true});
    assert.match(text,/中等CoT（2栏）/);assert.match(text,/不是后端实际执行证明/);
});

const option = n => `<choice${n}>候选${n}</choice${n}>`;
test('outer options closure cannot hide missing, duplicate, empty or reordered choices', () => {
    for(const body of [[1,2,3].map(option).join(''), [1,2,2,4].map(option).join(''), [2,1,3,4].map(option).join(''), [1,2,3].map(option).join('')+'<choice4></choice4>']){
        const output=analyzeOutput(`<Lin_options>${body}</Lin_options>`);
        assert.equal(output.openTags.length,0);assert.equal(output.incompleteOptions,1);
        assert.match(structureDiagnosis(output),/四选项结构不完整/);
    }
});
test('complete choices and fenced examples are not falsely called truncated', () => {
    assert.equal(analyzeOutput('<Lin_options>'+[1,2,3,4].map(option).join('')+'</Lin_options>').incompleteOptions,0);
    assert.equal(analyzeOutput('```html\n<Lin_options><choice1>示例\n```').optionBlocks,0);
    assert.equal(analyzeOutput('普通正文，没有选项要求。').incompleteOptions,0);
});
for (const content of [null, '']) test(`empty final message does not erase delivered delta (${JSON.stringify(content)})`, async () => {
    const frames=[{choices:[{delta:{content:'已经收到的完整文本。'}}]}, {choices:[{message:{content},finish_reason:'stop'}]}];
    const raw=frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n';
    const original=new Response(raw), [wire, untouched]=await Promise.all([inspectResponse(original.clone()),original.text()]);
    assert.equal(untouched,raw); assert.equal(wire.visibleChars,'已经收到的完整文本。'.length);assert.equal(wire.emptyFinalSnapshot,true);
});
test('byte-limited observation cannot truncate the original response', async () => {
    const raw='data: '+JSON.stringify({choices:[{delta:{content:'文'.repeat(10000)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
    const original=new Response(raw), [wire, untouched]=await Promise.all([inspectResponse(original.clone(),{maxBytes:16}),original.text()]);
    assert.equal(untouched,raw);assert.equal(wire.captureLimited,true);assert.equal(wire.limitReason,'bytes');
});
test('timed-out clone observation leaves the source stream alive', async () => {
    let cancelled=false;
    const raw='data: {"choices":[{"delta":{"content":"完整正文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const original=new Response(new ReadableStream({start(c){setTimeout(()=>{c.enqueue(new TextEncoder().encode(raw));c.close();},30);},cancel(){cancelled=true;}}));
    const [wire,untouched]=await Promise.all([inspectResponse(original.clone(),{timeoutMs:2}),original.text()]);
    assert.equal(untouched,raw);assert.equal(cancelled,false);assert.equal(wire.limitReason,'time');
});

const realPath=process.env.LIN262_PRESET_PATH;
for(const finishReason of ['SPII','MODEL_ARMOR']) test(`restriction is consistent in badge and detail: ${finishReason}`, () => {
    assert.equal(recordStatus({wire:{finishReason}}).label,'服务端限制');
    assert.match(responseDiagnosis({finishReason}),/接口报告拦截或限制/);
});
test('unspecified incomplete status does not invent token exhaustion', () => {
    assert.equal(recordStatus({wire:{incomplete:true}}).label,'接口响应未完成');
    assert.match(responseDiagnosis({incomplete:true,visibleChars:100}),/具体原因未提供/);
});
const real=realPath?JSON.parse(fs.readFileSync(realPath,'utf8')):null;
const realDigest=realPath?createHash('sha256').update(fs.readFileSync(realPath)).digest('hex'):null;
function realRequest(p,type){
    const order=p.prompt_order.find(x=>String(x.character_id)==='100001').order;
    return {type,model:'gemini-4-argon',stream:true,max_tokens:16384,reasoning_effort:'auto',enable_web_search:true,
        stop:['[END_CUSTOM]'],generationConfig:{maxOutputTokens:16384},
        messages:[{role:'user',content:'继续写一段普通日常。'},...order.filter(o=>o.enabled).flatMap(o=>{const p1=p.prompts.find(x=>x.identifier===o.identifier);return p1?.content&&p1.role?[{role:p1.role,content:p1.content}]:[];})]};
}
test('actual Lin2.6.2 activates medium CoT and keeps file byte-identical', {skip:!real}, () => {
    const profile=deliveryProfile(real);
    assert.equal(profile.cotEnabled,true);
    assert.deepEqual(profile.cotSources,[{identifier:COT_VARIANTS[1].id,variant:'中等CoT',columns:13}]);
    assert.equal(profile.inputPromptChars,36267);
    assert.equal(createHash('sha256').update(fs.readFileSync(realPath)).digest('hex'),realDigest);
});
for(let mask=0;mask<8;mask++)for(const mode of ['user','pair'])for(const type of ['normal','regenerate','swipe']){
    test(`actual Lin2.6.2 switches ${mask} / ${mode} / ${type}`, {skip:!real}, () => {
        const p=structuredClone(real),order=p.prompt_order.find(x=>String(x.character_id)==='100001').order;
        COT_VARIANTS.forEach((v,i)=>order.find(x=>x.identifier===v.id).enabled=!!(mask&(1<<i)));
        const req=realRequest(p,type),before=JSON.stringify({p,req});
        const result=planInjection(req,{...DEFAULTS,mode},{preset:p});
        const enabled=COT_VARIANTS.filter((v,i)=>mask&(1<<i));
        assert.equal(result.applied,true);assert.equal(result.deliveryGuard,true);
        assert.equal(result.profile.cotEnabled,enabled.length>0);assert.equal(result.profile.cotConflict,enabled.length>1);
        assert.deepEqual(result.profile.cotSources.map(x=>x.identifier).sort(),enabled.map(x=>x.id).sort());
        assert.equal(JSON.stringify({p,req}),before);
        const originalCue=p.prompts.find(x=>x.identifier===LIN_PROMPT_ID).content;
        assert.deepEqual(result.messages.slice(0,-result.injected.length),req.messages.filter(x=>!(x.role==='assistant'&&x.content===originalCue)));
        assert.doesNotMatch(result.messages.at(-1).content,/当前启用组件：|无附加组件|剧情停在交互节点/);
        if(enabled.length)assert.match(result.messages.at(-1).content,/500汉字/);
        const again=planInjection({...req,messages:result.messages},{...DEFAULTS,mode},{preset:p});
        assert.equal(again.changed,false);
    });
}
test('actual Lin2.6.2 continue, native-prefill and non-story request protections', {skip:!real}, () => {
    for(const type of ['quiet','impersonate'])assert.equal(planInjection(realRequest(real,type),{}, {preset:real}).applied,false);
    const req=realRequest(real,'continue');
    assert.equal(planInjection(req,{}, {preset:real}).reason,'continue-disabled');
    const result=planInjection(req,{enhanceContinue:true},{preset:real});
    assert.equal(result.applied,true);assert.match(result.messages.at(-1).content,/不重启整套/);
    assert.doesNotMatch(result.messages.at(-1).content,/500汉字|13项/);
    assert.equal(planInjection(req,{enhanceContinue:true},{preset:{...real,continue_prefill:true}}).reason,'native-prefill');
    for(const extra of [{tools:[{type:'function',function:{name:'test'}}]},{response_format:{type:'json_object'}},{assistant_prefill:'已有开头'}]){
        const input={...realRequest(real,'normal'),...extra},before=JSON.stringify(input);
        assert.equal(planInjection(input,{}, {preset:real}).applied,false);assert.equal(JSON.stringify(input),before);
    }
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {normalizeSettings} from '../core.js';import {compat290,layout290,systemKey} from '../lin290.js';
import {drawSample,project,verifyProjection,encodeWire,attachment} from '../auxiliary.js';import {createCoordinator} from '../coordinator.js';
import {preset,payload} from '../fixtures/protocol.mjs';
const modes=['off','standard','deep'],opts=(s={})=>normalizeSettings({requestMode:'gemini4',...s}),fixed=n=>Uint8Array.from({length:n},(_,i)=>i+1);
function rig(s={}){
 const settings=opts(s),ctx={chat:[],chatId:'one',chatCompletionSettings:preset()},recs=[];let calls=0,seq=0;
 const co=createCoordinator({getContext:()=>ctx,getSettings:()=>settings,id:()=>String(++seq),record:r=>recs.push(r),
     update:(id,p)=>Object.assign(recs.find(x=>x.id===id)||{},p),randomBytes:n=>{calls++;return fixed(n);}});
 const wire=(r,raw=JSON.stringify(r))=>{let send=co.before(r,raw);send?.sent?.();return send?.body??raw;};
 return {settings,ctx,co,wire,recs,calls:()=>calls};
}
for(const native of [false,true])for(const shield of modes)for(const macro of [false,true])
 test('real reversible projection '+(native?'Google':'chat')+' '+shield+' random='+macro,()=>{
 const r=payload({native}),f=rig({shield,macro}),before=JSON.stringify(r),src=structuredClone(r);f.co.start('normal');f.co.prepare(r);
 const sent=JSON.parse(f.wire(r));assert.equal(JSON.stringify(r),before);const aux=attachment(shield,macro?'01020304':'');
 if(!aux)assert.deepEqual(sent,src);else{const list=native?sent.systemInstruction.parts:sent.messages,removed=list.splice(2,1);assert.deepEqual(removed,[native?{text:aux}:{role:'system',content:aux}]);assert.deepEqual(sent,src);}
 assert.equal(f.calls(),macro?1:0);assert.equal(f.recs[0].experiment.committed,!!aux);
});
test('second group disagreement, dry run, revoked/preset switch, no lifecycle, ambiguity, other chat, quiet, stopped, changed final evidence are unchanged',()=>{
 const r=payload();for(const edit of [
 f=>f.co.reset(), f=>f.ctx.chatId='two', f=>f.settings.shield='off', f=>f.ctx.chatCompletionSettings.prompt_order[0].order[4].enabled=false,
 f=>f.co.prepare({...r,messages:[{role:'system',content:'other'},...r.messages]}),
 f=>f.co.forget(), f=>f.co.dispose(), f=>{f.ctx.chatCompletionSettings.name='Lin3.0.0';}
 ]){const f=rig({shield:'deep',macro:true});f.co.start('normal');f.co.prepare(r);edit(f);assert.equal(f.wire(r),JSON.stringify(r));assert.equal(f.calls(),0);}
 const f=rig({shield:'standard'});f.co.start('normal',true);f.co.prepare(r);assert.equal(f.wire(r),JSON.stringify(r));
 f.co.start('normal');f.co.prepare(r);const changed=structuredClone(r);changed.messages[0].content+='  ';assert.equal(f.wire(changed),JSON.stringify(changed));
 const quiet={...r,type:'quiet'};assert.equal(f.wire(quiet),JSON.stringify(quiet));
});
test('one draw per actual task across same or reassembled events and external retries; no exposed ticket or automatic send',()=>{
 const f=rig({shield:'deep',macro:true}),r=payload();f.co.start('normal');f.co.prepare(r);f.co.prepare(structuredClone(r));const first=f.wire(r);assert.equal(f.wire(structuredClone(r)),first);assert.equal(f.wire(JSON.parse(first)),first);assert.equal(f.calls(),1);
 assert.ok(!first.includes('ticket')&&!first.includes('requestId'));const swipe={...r,type:'swipe'};f.co.start('swipe');f.co.prepare(swipe);f.wire(swipe);assert.equal(f.calls(),2);
 const fresh=rig({macro:true,macroWhen:'normal'});fresh.co.start('swipe');fresh.co.prepare(swipe);assert.equal(fresh.wire(swipe),JSON.stringify(swipe));assert.equal(fresh.calls(),0);
 const copy=structuredClone(r);copy.messages.unshift({role:'system',content:'LPG sample=pre-existing'});f.co.start('normal');f.co.prepare(copy);assert.equal(f.wire(copy),JSON.stringify(copy));
});
test('3 lengths × 3 group counts × 2 safe positions; no sampling for deterministic shield',()=>{
 for(const name of ['short','medium','long'])for(const groups of [1,2,3])for(const pos of ['early','boundary']){
 const s=opts({shield:'deep',macro:true,macroSize:name,macroGroups:groups,auxPosition:pos}), sample=drawSample(s,fixed);
 assert.equal(sample.split('-').length,groups);assert.ok(sample.split('-').every(x=>x.length===({short:8,medium:16,long:24})[name]));const r=payload(),base=compat290(r,preset(),s),a=project(r,base,s,sample);
 assert.equal(a.aux.index,pos==='early'?1:2);assert.equal(JSON.parse(a.aux.text).lin.sample,sample);assert.ok(verifyProjection(r,a.out,base,a.aux));
 }
});
test('fault injection cannot rewrite existing text, roles, tool parameters, or unrelated root bytes',()=>{
 const r=payload(),s=opts({shield:'standard'}),b=compat290(r,preset(),s),z=project(r,b,s);
 for(const f of [o=>{o.messages=[...o.messages];o.messages[0]={...o.messages[0],content:'CHANGED'};},o=>o.top_p=0,o=>o.messages=o.messages.slice(1)]){const o={...z.out};f(o);assert.equal(verifyProjection(r,o,b,z.aux),false);assert.throws(()=>encodeWire(JSON.stringify(r),r,{...z,out:o},b));}
 const f=rig({shield:'standard'});f.co.start('normal');f.co.prepare(r);
 const original=JSON.stringify(r),dup=original.replace('"messages":','"messages":[],"messages":');assert.equal(f.wire(JSON.parse(dup),dup),dup);assert.equal(f.recs[0].experiment.status,'wire-guard');
 const keyed=original.replace(/}$/,',"opaque_num":9007199254740993123,"extra": {"a" : 1}}');assert.ok(f.wire(JSON.parse(keyed),keyed).includes('"opaque_num":9007199254740993123,"extra": {"a" : 1}'));
});
test('native snake_case is preserved, mixed payloads, signed turns, tool history, multimodal and nontext schema untouched',()=>{
 const s=opts({shield:'standard'}),r=payload({native:true});r.system_instruction=r.systemInstruction;delete r.systemInstruction;
 const b=compat290(r,preset(),s),a=project(r,b,s),out=JSON.parse(encodeWire(JSON.stringify(r),r,a,b));assert.ok(!('systemInstruction'in out));assert.equal(out.system_instruction.parts.length,3);
 for(const edit of [v=>v.contents[0].parts.push({thoughtSignature:'secret'}),v=>v.contents[0].parts.push({inlineData:{data:'fixture'}}),v=>v.contents[0].parts.push({functionResponse:{name:'g'}}),v=>v.messages=[],v=>v.systemInstruction={},v=>v.generationConfig={responseMimeType:'application/json'},v=>v.cachedContent='opaque']){const v=structuredClone(r);edit(v);assert.equal(compat290(v,preset(),s).changed,false);assert.ok(!compat290(v,preset(),s).proof);}
});
test('no independent place or system prompt off: skip aux, preserve tail; external HTTP services are never inferred',()=>{
 const r=payload(),f=rig({shield:'standard',macro:true});r.use_sysprompt=false;f.co.start('normal');f.co.prepare(r);assert.equal(f.wire(r),JSON.stringify(r));assert.equal(f.recs[0].experiment.status,'no-independent-slot');assert.equal(f.calls(),0);
});
test('whole user preset: same macro-expanded active snapshot for all six modes × both order groups',{skip:!process.env.LIN290_PRESET},()=>{
 const p=JSON.parse(fs.readFileSync(process.env.LIN290_PRESET,'utf8'));
 const expand=s=>s.replace(/\{\{(user|char|roll::[^{}]*|random::[^{}]*)\}\}/gi,(_,k)=>k==='user'?'读者甲':k==='char'?'人物乙':k.startsWith('random::')?k.slice(8).split('::')[0]:'317');
 for(const g of p.prompt_order){const order=g.order.filter(e=>e.enabled).flatMap(e=>{const d=p.prompts.find(x=>x.identifier===e.identifier);
    if(e.identifier==='chatHistory')return [{role:'user',content:'合成用户输入。'},{role:'assistant',content:'合成历史。'},{role:'user',content:'继续这个场景。'}];
    return d?.content&&d.role?[{role:d.role,content:expand(d.content)}]:[];});
 const r={...payload(),messages:order},raw=JSON.stringify(r);assert.ok(!raw.includes('{{'));assert.ok(layout290(p,'normal',g.character_id).cue);
 for(const mode of modes)for(const macro of [false,true]){
 const s=opts({shield:mode,macro}),b=compat290(r,p,s,g.character_id);assert.equal(b.reason,'290-ready');const z=project(r,b,s,macro?'01020304':''),sent=JSON.parse(encodeWire(raw,r,z,b));
 if(z.aux)sent.messages.splice(z.aux.index,1);assert.deepEqual(sent,r);assert.equal(raw,JSON.stringify(r));}
 }
});

test('ST backend search tools and root response MIME: preserve Google requests including reversed tails; use actual request flags',()=>{
 for(const source of ['makersuite','vertexai'])for(const patch of [{enable_web_search:true},{responseMimeType:'application/json'}]){
  const f=rig({shield:'deep',macro:true}),r=Object.assign(payload({source,reverse:true}),patch),raw=JSON.stringify(r);
  f.co.start('normal');f.co.prepare(r);assert.equal(f.wire(r),raw);assert.equal(f.calls(),0);
  assert.equal(f.recs[0].experiment.status,patch.enable_web_search?'290-host-search':'structured');
 }
 const f=rig({shield:'standard'});f.ctx.chatCompletionSettings.enable_web_search=true;
 const r={...payload({source:'vertexai'}),enable_web_search:false};
 f.co.start('normal');f.co.prepare(r);assert.notEqual(f.wire(r),JSON.stringify(r));
});

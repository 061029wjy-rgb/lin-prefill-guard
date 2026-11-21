import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {family,layout290,compat290,detectedNonce,target290} from '../lin290.js';
import {planInjection,normalizeSettings} from '../core.js';import {preset,payload} from '../fixtures/protocol.mjs';import {LIN_CONFIRM_ID as U} from '../gemini4.js';
const opts=normalizeSettings({});
test('2.9: both order groups; runtime roles; enabled empty placeholder creates nothing',()=>{
 const p=preset(), r=payload(); for(const group of [100000,100001,undefined]){let a=compat290(r,p,opts,group);assert.equal(a.reason,'290-ready');assert.strictEqual(a.ordered,r.messages);}
 assert.equal(detectedNonce(p),true);p.prompt_order[0].order.find(x=>x.identifier===U).enabled=false;
 assert.equal(layout290(p,'normal',100000).reason,'g4-disabled');assert.ok(!layout290(p,'normal',100001).reason);assert.ok(layout290(p).reason);
});
test('2.9: a unique transposed tail moves only the original cue; no old replacement/cap even in enhance',()=>{
 for(const mode of ['enhance','gemini4','gemini4-story']){let p=preset(),r=payload({reverse:true});let old=structuredClone(r),a=planInjection(r,{requestMode:mode,storyMoreTokens:true,reasoningMode:'balanced'},{preset:p});assert.equal(a.reason,'290-restored');assert.equal(a.messages.at(-1),r.messages.at(-2));assert.equal(a.messages.at(-2),r.messages.at(-1));assert.deepEqual(a.messages.slice(0,-2),r.messages.slice(0,-2));assert.deepEqual(r,old);assert.ok(!a.handoff);}
 const newer={...preset(),name:'Lin3.0.0'};assert.equal(planInjection(payload(),{requestMode:'enhance'},{preset:newer}).reason,'290-unknown');
});
test('2.9: protected protocols, ambiguous anchor, quiet/continue and edited wire skip losslessly',()=>{
 for(const native of [true,false])for(const edit of [r=>r.type='continue',r=>r.type='quiet',r=>r.type='impersonate',r=>r.tools=[{}],r=>r.response_format={type:'json_object'},r=>r.assistant_prefill='prefix',r=>{const x=native?r.contents:r.messages;x.push(structuredClone(x.at(-2)));},r=>{const x=native?r.contents.at(-1).parts[0]:r.messages.at(-1);x.thoughtSignature='fixture';}]){let r=payload({native,reverse:true});edit(r);let old=structuredClone(r),a=compat290(r,preset(),opts);assert.ok(!a.changed&&!a.proof);assert.deepEqual(r,old);}
});
test('2.9: target labels and protocol are checked separately; Neon not claimed verified',()=>{
 for(const model of ['argon','carbon','hydrogen','neon'])for(const source of ['vertexai','makersuite','custom'])assert.equal(target290(payload({model:'gemini-4-'+model,source})).upstreamVerified,false);
 assert.equal(target290(payload({model:'gemini-4-neon-preview'})),null);
 const p=preset();p.preset_settings_openai='Lin2.8.2';assert.equal(family(p),'protected');
});
test('user-supplied 2.9 reference: bytes/hash and both actual groups; preserve expanded messages', {skip:!process.env.LIN290_PRESET},()=>{
 const raw=fs.readFileSync(process.env.LIN290_PRESET);assert.equal(createHash('sha256').update(raw).digest('hex'),'bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766');
 const p=JSON.parse(raw),before=JSON.stringify(p);assert.equal(family({...p,name:undefined}),'290');
 for(const g of [100000,100001]){const l=layout290(p,'normal',g);assert.ok(l.cue);const r=payload({reverse:true});r.messages.at(-1).content=l.cue.content;r.messages.at(-2).content=l.confirm.content;assert.equal(compat290(r,p,opts,g).ordered.at(-1).content,l.confirm.content);}
 assert.equal(JSON.stringify(p),before);assert.equal(Buffer.compare(raw,fs.readFileSync(process.env.LIN290_PRESET)),0);
});

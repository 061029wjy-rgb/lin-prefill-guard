// Run against an explicitly supplied, pinned ST converter plus the two local preset files.
// No HTTP model call; the converter may mutate its input, so isolate each replay.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
import {compat290,layout290} from '../lin290.js';import {project} from '../auxiliary.js';import {planInjection,normalizeSettings} from '../core.js';import {LIN_PROMPT_ID as A,LIN_CONFIRM_ID as U} from '../gemini4.js';
const [converter,lin29,lin28,baseline]=process.argv.slice(2);if(!baseline)throw Error('usage: node scripts/host-replay.mjs PINNED-CONVERTER.mjs LIN29.json LIN28.json ORIGINAL/core.js');
const {convertGooglePrompt}=await import(pathToFileURL(resolve(converter)));const old=await import(pathToFileURL(resolve(baseline)));
const [p29,p28]=[lin29,lin28].map(f=>JSON.parse(fs.readFileSync(f)));
const shape=msgs=>({type:'normal',model:'gemini-4-carbon',chat_completion_source:'vertexai',use_sysprompt:true,max_tokens:16384,messages:msgs});
const q={role:'user',content:'本地合成的普通场景。'},h={role:'system',content:'框架规则。'},names={userName:'甲',charName:'乙',startsWithGroupName:()=>false};
const convert=ms=>convertGooglePrompt(structuredClone(ms),'gemini-4-carbon',true,names);let count=0;
for(const group of [100000,100001]){const l=layout290(p29,'normal',group),a={role:'assistant',content:l.cue.content},u={role:'user',content:l.confirm.content};
 const r=shape([h,q,a,u]);for(const shield of ['off','standard','deep'])for(const macro of [false,true]){
 const s=normalizeSettings({requestMode:'gemini4',shield,macro}),b=compat290(r,p29,s,group),z=project(r,b,s,macro?'01020304':'');
 const before=convert(r.messages),after=convert(z.out.messages);
 if(z.aux){const ps=after.system_instruction.parts,idx=ps.findIndex(x=>x.text===z.aux.text);assert.ok(idx>=0);ps.splice(idx,1);}
 assert.deepEqual(after,before);count++;}}
const get=(p,id)=>p.prompts.find(v=>v.identifier===id);const a={role:'assistant',content:get(p28,A).content},u={role:'user',content:get(p28,U).content};
let legacy=0;for(const mode of ['gemini4','gemini4-story'])for(const type of ['normal','regenerate','swipe','continue'])for(const flip of [false,true]){
 const r={...shape([h,q,...(flip?[u,a]:[a,u])]),type},s={requestMode:mode,storyMoreTokens:true};
 const oldResult=old.planInjection(r,s,{preset:p28}),next=planInjection(r,s,{preset:p28});
 assert.deepEqual(next,oldResult);legacy++;}
console.log('Reference converter SHA-256:',createHash('sha256').update(fs.readFileSync(converter)).digest('hex'));
console.log('PASS actual ST converter, remove only owned system part: '+count+' cases; same contents, user confirmation and every original system part.');
console.log('PASS identical full 2.8.2 plans vs repository 1.3.0: '+legacy+' cases (including optional cap). No provider contacted.');

// Offline A/B packet. Does not load chat, call a provider or edit a preset.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve,join} from 'node:path';
import {normalizeSettings} from '../core.js';import {compat290} from '../lin290.js';import {project} from '../auxiliary.js';
const cases=JSON.parse(readFileSync(new URL('../fixtures/literary-cases.json',import.meta.url)));
const modes=[['off',false],['standard',false],['deep',false],['off',true],['standard',true],['deep',true]];
const scores=['角色权限','无凭空知情','语言自然','正文与组件','任务完成'];
const hash=x=>createHash('sha256').update(x).digest('hex');
function prep(src,dir){
 const p=JSON.parse(readFileSync(src)),g=p.prompt_order.find(x=>String(x.character_id)==='100001');if(!g)throw Error('missing group');
 const expand=s=>s.replace(/\{\{(user|char|roll::[^{}]*|random::[^{}]*)\}\}/gi,(_,k)=>k==='user'?'读者甲':k==='char'?'人物乙':k.startsWith('random::')?k.slice(8).split('::')[0]:'317');
 const key=[],sheet=[],pack=[];for(const c of cases){
   const ms=g.order.filter(x=>x.enabled).flatMap(x=>{if(x.identifier==='chatHistory')return [{role:'user',content:c.scene}];const d=p.prompts.find(z=>z.identifier===x.identifier);return d?.content&&d.role?[{role:d.role,content:expand(d.content)}]:[];});
   const base={type:'normal',messages:ms,model:'gemini-4-carbon',chat_completion_source:'vertexai',use_sysprompt:true,enable_web_search:false,stream:false,temperature:p.temperature,top_p:p.top_p,max_tokens:p.openai_max_tokens};
   for(const [shield,macro] of modes){
     const s=normalizeSettings({requestMode:'gemini4',shield,macro}),b=compat290(base,p,s,100001);if(!b.proof)throw Error('preset tail cannot be verified');
     const sample=macro?hash(c.id).slice(0,8):'',q=project(base,b,s,sample),blind=hash('lin-ab-v1/'+c.id+shield+macro).slice(0,12);
     key.push({blind,case:c.id,shield,macro,baselineHash:hash(JSON.stringify(base)),snapshotHash:hash(JSON.stringify(q.out))});
     pack.push({blind,request:q.out});sheet.push({blind,case:c.id,rubric:c.rubric,ran:false,model:null,channel:null,finish:null,refused:null,empty:null,truncated:null,formatOK:null,complete:null,latencyMs:null,inputTokens:null,cachedTokens:null,...Object.fromEntries(scores.map(k=>[k,null]))});
   }
 }
 mkdirSync(dir,{recursive:false});for(const [name,rows] of [['requests',pack],['ratings',sheet],['key',key]])writeFileSync(join(dir,name+'.json'),JSON.stringify(rows.sort((x,y)=>x.blind.localeCompare(y.blind)),null,2)+'\n');
 console.log(cases.length+' fixed cases × '+modes.length+' modes = '+pack.length+' local plain-text packets (web search explicitly off for all six groups); no network request. requests.json contains your expanded preset; keep it private.');
}
function grade(dir){
 const ratings=JSON.parse(readFileSync(join(dir,'ratings.json'))),key=new Map(JSON.parse(readFileSync(join(dir,'key.json'))).map(x=>[x.blind,x]));
 const buckets=new Map(),seen=new Set();for(const row of ratings){if(!row.ran)continue;
 const k=key.get(row.blind);if(!k||seen.has(row.blind)||!row.model||!row.channel)throw Error('unmatched, duplicate, or missing model/channel');seen.add(row.blind);
 const group=JSON.stringify([row.model,row.channel,k.shield,k.macro]);if(!buckets.has(group))buckets.set(group,[]);buckets.get(group).push(row);}
 const report=Array.from(buckets,([group,rs])=>({group:JSON.parse(group),n:rs.length,
   ...Object.fromEntries(['refused','empty','truncated','formatOK','complete'].map(k=>{const v=rs.filter(r=>typeof r[k]==='boolean');return [k,{observed:v.length,yes:v.filter(r=>r[k]).length}];})),
   ...Object.fromEntries([...scores,'latencyMs','inputTokens','cachedTokens'].map(k=>{const v=rs.map(r=>r[k]).filter(x=>Number.isFinite(x)&&(scores.includes(k)?x>=1&&x<=5:x>=0));return [k,{observed:v.length,mean:v.length?v.reduce((a,b)=>a+b,0)/v.length:null}];}))}));
 console.log(JSON.stringify({observed:seen.size,groups:report},null,2));
}
const [op,...args]=process.argv.slice(2);if(op==='prepare'&&args.length===2)prep(resolve(args[0]),resolve(args[1]));else if(op==='score'&&args.length===1)grade(resolve(args[0]));else throw Error('node scripts/ab.mjs prepare PRESET.json NEW-DIR  |  score DIR');

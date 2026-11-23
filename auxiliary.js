// Owned input experiment. No macros execute on source text. A request sample is not a credential.
import {systemKey} from './lin290.js?v=1.4.2';
const encoder=new TextEncoder();
export {drawSample} from './sample-session.js?v=1.4.2';
export function attachment(mode,sample) {
    if(mode==='deep')return JSON.stringify({lin:{format:1,...(sample?{sample}: {})}});
    if(mode==='standard')return 'LPG format=1'+(sample?' sample='+sample:'');
    return sample?'LPG sample='+sample:'';
}
function area(r,base,where){
    if(base.kind==='native')return {index:where==='early'?1:r[systemKey(r)].parts.length,key:systemKey(r)+'.parts'};
    if(['vertexai','makersuite'].includes(r.chat_completion_source)&&r.use_sysprompt!==true)return null;
    const head=base.ordered.findIndex(m=>m.role!=='system');
    if(head<1||!base.ordered.slice(0,head).some(m=>typeof m.content==='string'?m.content.trim():m.content.some(b=>b.text.trim())))return null;
    return {index:where==='early'?1:head,key:'messages'};
}
const at=(xs,i,x)=>[...xs.slice(0,i),x,...xs.slice(i)];
const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
function sameOther(a,b,except) {
    const ka=Object.keys(a).filter(k=>!except.includes(k)),kb=Object.keys(b).filter(k=>!except.includes(k));
    return ka.length===kb.length&&ka.every(k=>Object.hasOwn(b,k)&&a[k]===b[k]);
}
export function verifyProjection(input,out,base,aux) {
    if(!base.proof)return out===input&&!aux;
    const native=base.kind==='native',key=native?'contents':'messages';
    if(!sameOther(input,out,native?['contents',systemKey(input)]:['messages']))return false;
    const original=input[key], expected=[...original];
    if(base.proof.move)[expected[expected.length-2],expected[expected.length-1]]=[original.at(-1),original.at(-2)];
    if(!same(base.ordered,expected))return false;
    if(!aux)return same(out[key],expected)&&(!native||out[systemKey(input)]===input[systemKey(input)]);
    const i=aux.index,obj=aux.node;
    if(!Number.isInteger(i)||i<1||obj==null)return false;
    if(native)return aux.key===systemKey(input)+'.parts' && obj.text===aux.text && Object.keys(obj).length===1 &&
        i<=input[systemKey(input)].parts.length && sameOther(input[systemKey(input)],out[systemKey(input)],['parts']) &&
        same(out.contents,expected)&&same(out[systemKey(input)].parts,at(input[systemKey(input)].parts,i,obj));
    const head=expected.findIndex(m=>m.role!=='system');
    return i<=head&&aux.key==='messages'&&same(out.messages,at(expected,i,obj))&&obj.role==='system'&&obj.content===aux.text&&Object.keys(obj).length===2;
}
export function project(input,base,settings,sample='') {
    if(!base.proof)return {out:input,aux:null,note:base.reason};
    const key=base.kind==='native'?'contents':'messages';
    let out=base.proof.move?{...input,[key]:base.ordered}:input;
    const needsSample=settings.macro&&(settings.macroWhen!=='normal'||base.type==='normal');
    const text=attachment(settings.shield,needsSample?sample:'');
    if(!text)return {out,aux:null,note:needsSample?'no-random':'off'};
    const pos=area(input,base,settings.auxPosition);
    if(!pos)return {out,aux:null,note:'no-independent-slot'};
    // A coincidentally similar string is not proof of ownership. Never strip it or add a second one.
    const prior=key==='messages'?input.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.map(p=>p.text))
        :[...input[systemKey(input)].parts,...input.contents.flatMap(c=>c.parts)].map(x=>x.text);
    if(prior.some(s=>s===text||s.startsWith('LPG sample=')||s.startsWith('LPG format=')||s.startsWith('{"lin":{"format":1')))return {out:input,aux:null,note:'unowned-marker'};
    const node=key==='messages'?{role:'system',content:text}:{text};
    const aux={...pos,text,node,bytes:encoder.encode(text).length,sample:needsSample?sample:''};
    out=key==='messages'?{...out,messages:at(base.ordered,pos.index,node)}:{...out,[systemKey(input)]:{...input[systemKey(input)],parts:at(input[systemKey(input)].parts,pos.index,node)}};
    return {out,aux,note:'owned-slot'};
}

// Change the literal values of at most two *verified* top-level fields. Numeric precision,
// duplicate unrelated nested keys, escapes and whitespace in every OTHER field stay byte-for-byte.
function scan(raw) {
    let i=0; const spaces=()=>{while(i<raw.length&&/\s/.test(raw[i]))i++;};
    function string(){if(raw[i++]!=='"')throw Error('not a string');while(i<raw.length){const c=raw[i++];if(c==='\\')i++;else if(c==='"')return;}throw Error('unclosed');}
    function end(){let depth=0;while(i<raw.length){const c=raw[i];if(c==='"'){string();continue;}if(!depth&&('},'.includes(c)))break;if(c==='['||c==='{')depth++;if(c===']'||c==='}')depth--;i++;}return i;}
    const keys=new Map(); spaces();if(raw[i++]!=='{')throw Error('not an object');spaces();
    while(i<raw.length&&raw[i]!=='}'){const start=i;string();const key=JSON.parse(raw.slice(start,i));if(keys.has(key))throw Error('duplicate key');
        spaces();if(raw[i++]!==':')throw Error('missing colon');spaces();const a=i,b=end();let j=b;while(j>a&&/\s/.test(raw[j-1]))j--;
        keys.set(key,[a,j]);if(raw[i]==='}')break;if(raw[i++]!==',')throw Error('bad field');spaces();}
    return keys;
}
export function encodeWire(raw,input,plan,base) {
    const {out,aux}=plan;if(out===input)return raw;
    if(!verifyProjection(input,out,base,aux))throw Error('projection rejected');
    const keys=scan(raw), edits=[];
    for(const k of ['messages','contents','systemInstruction','system_instruction'])if(input[k]!==out[k]){
        const span=keys.get(k);if(!span)throw Error('missing field');
        // Only accept the host's ordinary JSON.stringify form inside rewritten fields.
        // A foreign serializer with ambiguous/duplicate nested fields is forwarded unchanged.
        if(raw.slice(...span)!==JSON.stringify(input[k]))throw Error('noncanonical protected field');
        edits.push([...span,JSON.stringify(out[k])]);
    }
    let result=raw;for(const [a,b,text] of edits.sort((x,y)=>y[0]-x[0]))result=result.slice(0,a)+text+result.slice(b);
    return result;
}

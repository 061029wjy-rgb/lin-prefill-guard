const size={short:8,medium:16,long:24};
const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
export function drawSample(settings,getBytes=n=>globalThis.crypto.getRandomValues(new Uint8Array(n))) {
    const chars=size[settings.macroSize]??8, groups=['1','2','3'].includes(String(settings.macroGroups))?Number(settings.macroGroups):1;
    const bytes=getBytes(chars*groups/2);
    if(!(bytes instanceof Uint8Array)||bytes.length!==chars*groups/2)throw Error('random source unavailable');
    return Array.from({length:groups},(_,i)=>hex(bytes.subarray(i*chars/2,(i+1)*chars/2))).join('-');
}

// A controlled comparison can reuse a sample for the SAME user turn. No chat text, hash,
// sample or object reference is stored on disk. Normal generations always draw afresh.
export function sampleSession(){
    let prior=null,staged=null;
    function anchor(ctx){
        const c=ctx.chat,room=ctx.getCurrentChatId?.()??ctx.chatId;if(!Array.isArray(c)||room==null||(ctx.groupId!=null&&ctx.characterId==null))return null;
        const i=c.findLastIndex(m=>m?.is_user===true&&!m.is_system);
        const m=c[i];if(i<0||typeof m?.mes!=='string'||!m.mes.trim())return null;
        return [c,room,ctx.characterId,ctx.groupId,i,m,m.mes,m.swipe_id];
    }
    return {clear(){prior=null;staged=null;},dropPending(){staged=null;},submitted(sample){if(staged?.sample===sample){prior=staged;staged=null;}},take(s,ctx,type,getBytes){
        if(s.macroWhen!=='reuse'){prior=null;staged=null;return drawSample(s,getBytes);}
        const a=anchor(ctx), format=s.macroSize+':'+s.macroGroups;
        if(type!=='normal'&&a&&prior?.format===format&&a.every((v,i)=>v===prior.anchor[i]))return prior.sample;
        // A variant without a verified preceding sample must not silently receive a fresh one.
        if(type!=='normal')return '';
        prior=null;const sample=drawSample(s,getBytes);staged=a?{format,anchor:a,sample}:null;return sample;
    }};
}

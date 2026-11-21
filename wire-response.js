// Optional observer of the bytes the host actually consumes. The tap has zero read-ahead,
// never owns an independent network consumer and never rewrites a single response byte.
export function observeConsumed(response,{finish,failed,clock=Date.now,limit=2*1024*1024,limitMs=600000,live=()=>true}) {
    if(!response?.body || response.bodyUsed || response.status===0)return response;
    const started=clock(),chunks=[];let reader=null,size=0,finished=false,discard=false,first=null,last=null,gap=0,reads=0;
    const timer=setTimeout(()=>{discard='time';chunks.length=0;},limitMs);timer.unref?.();
    function done(kind,error){
        if(finished)return;finished=true;clearTimeout(timer);
        try{reader?.releaseLock();}catch{}
        if(live())try{
            if(kind!=='eof'||discard)failed({receivedBytes:size,captureLimited:true,limitReason:discard||kind,aborted:kind==='cancel'||error?.name==='AbortError',networkError:kind==='read-error'&&error?.name!=='AbortError'});
            else finish(chunks.splice(0),{receivedBytes:size,networkReads:reads,firstByteMs:first,maxGapMs:gap,durationMs:clock()-started});
        }catch{}
        chunks.length=0;
    }
    const body=new ReadableStream({
        async pull(ctrl){
            try{reader??=response.body.getReader();const part=await reader.read();
                if(part.done){ctrl.close();done('eof');return;}
                const n=clock();if(last!=null)gap=Math.max(gap,n-last);last=n;first??=n-started;reads++;size+=part.value.byteLength;
                if(!discard&&size<=limit&&live())chunks.push(part.value.slice());else {discard||='bytes';chunks.length=0;}
                ctrl.enqueue(part.value);
            }catch(e){ctrl.error(e);done('read-error',e);}
        },
        async cancel(reason){try{if(reader)await reader.cancel(reason);else await response.body.cancel(reason);}finally{done('cancel');}}
    },{highWaterMark:0});
    const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    Object.defineProperties(wrapped,Object.fromEntries(['url','redirected','type'].map(k=>[k,{get:()=>response[k]}])));
    return wrapped;
}

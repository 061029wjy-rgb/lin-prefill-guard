// Isolated conformance lab. No URL, fetch, host action, provider setting or ST callback.
const name='lin_preview_text';
const schema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&typeof v[k]==='string';
export function labRequest(format) {
    if(format==='google')return {contents:[{role:'user',parts:[{text:'协议回显测试'}]}],tools:[{functionDeclarations:[{name,parameters:schema}]}]};
    if(format==='chat')return {messages:[{role:'user',content:'协议回显测试'}],tools:[{type:'function',function:{name,parameters:schema}}]};
    throw Error('unknown fixture protocol');
}
export function labReply(format,input) {
    let call,turn,text,signature;
    if(format==='google'){
        const c=input?.candidates;if(c?.length!==1||c[0].finishReason!=='STOP')throw Error('not a complete candidate');
        turn=c[0].content;const parts=turn?.parts;if(turn?.role!=='model'||parts?.length!==1)throw Error('ambiguous parts');
        call=parts[0].functionCall;signature=parts[0].thoughtSignature;
        if(typeof signature!=='string'||!signature||call?.name!==name||!exact(call.args,'text'))throw Error('invalid signed call');
        text=call.args.text;
    }else if(format==='chat'){
        const c=input?.choices;if(c?.length!==1||c[0].finish_reason!=='tool_calls')throw Error('not a complete call');
        turn=c[0].message;const calls=turn?.tool_calls;
        if(turn?.role!=='assistant'||turn.content||calls?.length!==1)throw Error('ambiguous call');
        call=calls[0];if(call.type!=='function'||call.function?.name!==name||typeof call.id!=='string'||!call.id)throw Error('wrong tool');
        const args=JSON.parse(call.function.arguments);if(!exact(args,'text'))throw Error('schema');text=args.text;
    }else throw Error('unknown protocol');
    if(!text.length)throw Error('empty result');
    // The tool only echoes the argument the fixture model actually returned. A different result cannot be "restored".
    return {turn,reply:format==='google'?{role:'user',parts:[{functionResponse:{name,id:call.id,response:{text}}}]}:
        {role:'tool',tool_call_id:call.id,content:JSON.stringify({text})},text,signature};
}
export function verifyLabPair(format,original,reply){
    const a=labReply(format,original);
    if(format==='google'){
        const fr=reply?.parts?.[0]?.functionResponse; if(reply?.role!=='user'||reply.parts.length!==1||fr?.name!==name||
            fr.id!==a.reply.parts[0].functionResponse.id||!exact(fr.response,'text')||fr.response.text!==a.text)throw Error('mismatched result');
    }else if(reply?.role!=='tool'||reply.tool_call_id!==a.reply.tool_call_id||reply.content!==a.reply.content)throw Error('mismatched result');
    return a.text;
}
export function readLabStream(wire) {
    // Strictly the documented local Chat fixture protocol; no best-effort JSON repair.
    let id='',fn='',args='',finished=false,done=false;
    for(const frame of wire.replaceAll('\r\n','\n').split('\n\n')){
        if(!frame.trim())continue;
        if(done)throw Error('data follows DONE');
        const lines=frame.split('\n').filter(x=>x.startsWith('data:'));if(!lines.length)continue;
        const data=lines.map(x=>x.slice(5).trimStart()).join('\n');
        if(data==='[DONE]'){done=true;continue;}
        const f=JSON.parse(data),c=f.choices?.[0];if(f.error||!c||f.choices.length!==1||c.index!==0||c.delta?.content||finished)throw Error('mixed content');
        for(const t of c.delta?.tool_calls||[]){
            if(t.index!==0||t.type&&t.type!=='function'||(t.id&&id&&id!==t.id))throw Error('mixed call');
            if(t.id)id=t.id;if(t.function?.name)fn+=t.function.name;if(t.function?.arguments)args+=t.function.arguments;
        }
        if(c.finish_reason!=null){if(c.finish_reason!=='tool_calls')throw Error('not complete');finished=true;}
    }
    if(!done||!finished)throw Error('incomplete stream');
    return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id,type:'function',function:{name:fn,arguments:args}}]}}]};
}
export function runLocalDemo(){
    const req=labRequest('chat');const model={choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'local-1',type:'function',function:{name:req.tools[0].function.name,arguments:JSON.stringify({text:'雨停了。'})}}]}}]};
    const parsed=labReply('chat',model);return verifyLabPair('chat',model,parsed.reply);
}

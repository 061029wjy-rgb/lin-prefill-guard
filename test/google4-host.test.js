import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createController } from '../controller.js';
import { LIN_PROMPT_ID, LIN_CONFIRM_ID } from '../gemini4.js';

const file = 'src/endpoints/backends/chat-completions.js';
const patch = fileURLToPath(new URL('../compat/st-1.19.1-gemini4.patch', import.meta.url));
const host = process.env.LPG_ST_PATH;
const input = process.env.LIN291_LOW_PRESET;

// Load the published functions with their original code. Replace transport,
// credentials, host configuration and Express response plumbing for this test.
function hostFunction(source, name, dependencies) {
    const declaration = new RegExp('^(?:export )?((?:async )?function ' + name + '\\([^]*?^\\})', 'm');
    const code = source.match(declaration)?.[1];
    assert.ok(code, 'ST function missing: '+name);
    return runInNewContext('('+code+')', dependencies);
}

test('SillyTavern 1.19.1 actual Google handler and converter, stock and patched, against a loopback endpoint',
    {skip:!host || !input}, async t => {
    const preset = JSON.parse(await readFile(input,'utf8'));
    const raw = await readFile(join(host,file),'utf8');
    const converter = await readFile(join(host,'src/prompt-converters.js'),'utf8');
    const temp = await mkdtemp(join(tmpdir(),'lin-google4-'));
    t.after(()=>rm(temp,{recursive:true,force:true}));
    await mkdir(dirname(join(temp,file)),{recursive:true});
    await writeFile(join(temp,file),raw);
    execFileSync('git',['apply','--check',patch],{cwd:temp});
    execFileSync('git',['apply',patch],{cwd:temp});
    const updated = await readFile(join(temp,file),'utf8');
    execFileSync('git',['apply','-R',patch],{cwd:temp});
    assert.equal(await readFile(join(temp,file),'utf8'),raw);

    const calls=[];
    const endpoint=createServer(async(req,res)=>{
        const chunks=[];
        for await (const piece of req) chunks.push(piece);
        calls.push(JSON.parse(Buffer.concat(chunks).toString()));
        const packet={candidates:[{content:{role:'model',parts:[{text:'收到。'}]},finishReason:'STOP'}],
            usageMetadata:{thoughtsTokenCount:9,candidatesTokenCount:2}};
        const streaming=req.url==='/stream';
        res.writeHead(200,{'Content-Type':streaming?'text/event-stream':'application/json'});
        res.end(streaming?'data: '+JSON.stringify(packet)+'\n\n':JSON.stringify(packet));
    });
    endpoint.listen(0,'127.0.0.1');await once(endpoint,'listening');
    t.after(()=>new Promise(resolve=>endpoint.close(resolve)));
    const loop='http://127.0.0.1:'+endpoint.address().port;
    const getConfigValue=(_key,fallback)=>fallback;
    const convertGooglePrompt=hostFunction(converter,'convertGooglePrompt',{getConfigValue});
    const cue=preset.prompts.find(p=>p.identifier===LIN_PROMPT_ID);
    const confirm=preset.prompts.find(p=>p.identifier===LIN_CONFIRM_ID);
    const messages=[{role:'system',content:'续写当前场景。'},{role:'user',content:'请继续。'},
        ...[cue,confirm].map(({role,content})=>({role,content}))];
    async function run(source,model,stock,stream,mutation={},authType='express') {
        const listeners=new Map();
        const ctx={chat:[], chatCompletionSettings:preset,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
            eventSource:{on:(e,f)=>listeners.set(e,f),removeListener:()=>{}}};
        const ctl=createController({getContext:()=>ctx,getOrderId:()=>100001,
            getSettings:()=>({requestMode:'gemini4',captureNetwork:false}),networkTarget:{}});
        const outgoing={model,chat_completion_source:source,stream,type:'normal',max_tokens:8192,temperature:1,
            top_p:.93,top_k:32,n:1,use_sysprompt:true,enable_web_search:true,reasoning_effort:preset.reasoning_effort,
            include_reasoning:preset.show_thoughts,stop:['END-SCENE'],messages:structuredClone(messages)};
        try {listeners.get('ready')(outgoing);} finally {ctl.dispose();}
        Object.assign(outgoing,mutation);  // A downstream extension or a different route can change these.
        const browserBody=JSON.parse(JSON.stringify(outgoing));
        const request={body:browserBody,user:{directories:{}},socket:new EventEmitter()};
        const response={headers:{},code:200,setHeader(key,value){this.headers[key.toLowerCase()]=value;},
            status(code){this.code=code;return this;},send(value){this.value=value;},end(){}};
        const convert=hostFunction(stock?raw:updated,'sendMakerSuiteRequest',{
            URL,AbortController,convertGooglePrompt, getConfigValue,getPromptNames:()=>({}),
            CHAT_COMPLETION_SOURCES:{VERTEXAI:'vertexai'},API_VERTEX_AI:'https://aiplatform.googleapis.com',
            API_MAKERSUITE:'https://generativelanguage.googleapis.com',getVertexAIAuth:async()=>({authType,authHeader:'Bearer fixture'}),
            readSecret:(_dirs,key)=>key==='account'?'{"project_id":"fixture"}':'fixture',
            SECRET_KEYS:{MAKERSUITE:'studio',VERTEXAI_SERVICE_ACCOUNT:'account'},
            GEMINI_SAFETY:[],VERTEX_SAFETY:[],console:{info(){},debug(){},warn(){},error(){}},
            util:{inspect:()=>''},color:{red:String},getProjectIdFromServiceAccount:account=>account.project_id,
            fetch:async(_providerUrl,options)=>fetch(loop+(stream?'/stream':'/json'),options),
            forwardFetchResponse:async(up,down)=>down.send(await up.text()),
        });
        const before=calls.length;
        await convert(request,response);
        assert.equal(response.code,200,JSON.stringify(response.value));
        assert.equal(calls.length,before+1);
        return {body:calls.at(-1),receipt:response.headers['x-lin-gemini-thinking']};
    }
    for(const source of ['makersuite','vertexai']) for(const model of ['gemini-4-carbon','gemini-4-argon']) {
        for(const stream of [false,true]) await t.test(source+' / '+model+(stream?' SSE':' JSON'),async()=>{
            const old=await run(source,model,true,stream), current=await run(source,model,false,stream);
            assert.equal(old.body.generationConfig.thinkingConfig,undefined);assert.equal(old.receipt,undefined);
            assert.deepEqual(current.body.generationConfig.thinkingConfig,{thinkingLevel:'LOW',includeThoughts:false});
            assert.equal(current.receipt,'low-no-summary');
            const expected=structuredClone(old.body);
            for(const field of ['temperature','topP','topK']) delete expected.generationConfig[field];
            expected.generationConfig.thinkingConfig={thinkingLevel:'LOW',includeThoughts:false};
            assert.deepEqual(current.body,expected);
            assert.deepEqual(current.body.contents.slice(-2),[{role:'model',parts:[{text:cue.content}]},
                {role:'user',parts:[{text:confirm.content}]}]);
            assert.equal('lin_gemini4_low_thinking' in current.body,false);
        });
    }
    await t.test('server rechecks downstream overrides and proxy auth',async()=>{
        for(const [edit,auth] of [[{lin_gemini4_low_thinking:undefined}],[{model:'gemini-4-neon'}],
            [{model:'relay/gemini-4-carbon'}],[{reasoning_effort:'high'}],[{include_reasoning:true}],
            [{type:'quiet'}],[{reverse_proxy:'http://localhost/'}],[{},'proxy']]) {
            const a=await run('vertexai','gemini-4-carbon',true,false,edit,auth);
            const b=await run('vertexai','gemini-4-carbon',false,false,edit,auth);
            assert.equal(b.receipt,undefined);assert.deepEqual(b.body,a.body);
        }
    });
    await t.test('Vertex service account route forwards the same two parameters',async()=>{
        const a=await run('vertexai','gemini-4-argon',false,false,{},'full');
        assert.deepEqual(a.body.generationConfig.thinkingConfig,{thinkingLevel:'LOW',includeThoughts:false});
        assert.equal(a.receipt,'low-no-summary');
    });
});

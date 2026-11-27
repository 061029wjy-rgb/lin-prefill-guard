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
import { planInjection } from '../core.js';
import { googleProxyKey } from '../prefill.js';
import { addResponseData } from '../observer.js';
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
    async function run(source,model,stock,stream,mutation={},authType='express',active=preset,inputMessages=messages,orderId=100001) {
        const listeners=new Map();
        const ctx={chat:[], chatCompletionSettings:active,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
            eventSource:{on:(e,f)=>listeners.set(e,f),removeListener:()=>{}}};
        const ctl=createController({getContext:()=>ctx,getOrderId:()=>orderId,
            getSettings:()=>({requestMode:'gemini4',captureNetwork:false}),networkTarget:{}});
        const outgoing={model,chat_completion_source:source,stream,type:'normal',max_tokens:8192,temperature:1,
            top_p:.93,top_k:32,n:1,use_sysprompt:true,enable_web_search:true,reasoning_effort:active.reasoning_effort,
            include_reasoning:active.show_thoughts,stop:['END-SCENE'],messages:structuredClone(inputMessages)};
        try {listeners.get('ready')(outgoing);} finally {ctl.dispose();}
        Object.assign(outgoing,mutation);  // A downstream extension or a different route can change these.
        const browserBody=JSON.parse(JSON.stringify(outgoing));
        const request={body:structuredClone(browserBody),user:{directories:{}},socket:new EventEmitter()};
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
        return {body:calls.at(-1),browserBody,receipt:response.headers['x-lin-gemini-thinking']};
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
    for (const env of ['LIN293_PRESET','LIN293_FY_PRESET']) {
        await t.test(env+' through the stock and patched handler', {skip:!process.env[env]}, async () => {
            const active = JSON.parse(await readFile(process.env[env],'utf8'));
            const ends = [LIN_PROMPT_ID,LIN_CONFIRM_ID].map(id => {
                const {role,content} = active.prompts.find(d => d.identifier === id);
                return {role,content};
            });
            for (const id of [100000,100001]) for (const source of ['vertexai','makersuite']) {
                const input = [messages[0],messages[1],ends[1],ends[0]];
                const original = await run(source,'gemini-4-carbon',true,false,{},'express',active,input,id);
                const current = await run(source,'gemini-4-carbon',false,false,{},'express',active,input,id);
                assert.equal(current.receipt,undefined);
                assert.equal(current.browserBody.lin_gemini4_low_thinking,undefined);
                assert.equal(current.browserBody.reasoning_effort,active.reasoning_effort);
                assert.equal(current.browserBody.messages.length,input.length);
                assert.deepEqual(current.browserBody.messages.slice(-2),ends);
                assert.deepEqual(current.body,original.body);
                assert.deepEqual(current.body.contents.slice(-2),ends.map(({role,content}) =>
                    ({role:role === 'assistant' ? 'model' : 'user',parts:[{text:content}]})));
            }
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

test('stock ST native prefix forwarding and optional non-streaming usage passthrough',
    { skip: !host || !process.env.LIN293_FY_PRESET }, async t => {
    const preset = JSON.parse(await readFile(process.env.LIN293_FY_PRESET, 'utf8'));
    const source = await readFile(join(host, file), 'utf8');
    const converter = await readFile(join(host, 'src/prompt-converters.js'), 'utf8');
    const usagePatch = fileURLToPath(new URL('../compat/st-1.19.1-token-usage.patch', import.meta.url));
    const temp = await mkdtemp(join(tmpdir(), 'lin-prefill-host-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    await mkdir(dirname(join(temp, file)), { recursive: true });
    await writeFile(join(temp, file), source);
    execFileSync('git', ['apply', '--check', usagePatch], { cwd: temp });
    execFileSync('git', ['apply', usagePatch], { cwd: temp });
    const patched = await readFile(join(temp, file), 'utf8');
    execFileSync('git', ['apply', '-R', usagePatch], { cwd: temp });
    assert.equal(await readFile(join(temp, file), 'utf8'), source);
    execFileSync('git', ['apply', patch], { cwd: temp });
    execFileSync('git', ['apply', '--check', usagePatch], { cwd: temp });

    const getConfigValue = (_key, fallback) => fallback;
    const REASONING_EFFORT = Object.fromEntries(['auto', 'min', 'low', 'medium', 'high', 'max'].map(value => [value, value]));
    const PROMPT_PROCESSING_TYPE = { MERGE:'merge', CLAUDE:'claude', MERGE_TOOLS:'merge_tools', SEMI:'semi',
        SEMI_TOOLS:'semi_tools', STRICT:'strict', STRICT_TOOLS:'strict_tools', SINGLE:'single' };
    const getHostConverter = (name, deps = {}) => hostFunction(converter, name, {
        getConfigValue, REASONING_EFFORT, PROMPT_PROCESSING_TYPE, PROMPT_PLACEHOLDER: '开始。', ...deps,
    });
    const deps = {
        URL, AbortController, process, getConfigValue, PROMPT_PROCESSING_TYPE, getPromptNames: () => ({}),
        getVertexAIAuth: async () => ({ authType: 'proxy', authHeader: 'Bearer fixture' }),
        CHAT_COMPLETION_SOURCES: { VERTEXAI: 'vertexai' },
        API_VERTEX_AI: 'https://aiplatform.googleapis.com', API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        API_DEEPSEEK: 'https://api.deepseek.com/beta', API_MISTRAL: 'https://api.mistral.ai/v1',
        API_CLAUDE: 'https://api.anthropic.com/v1', readSecret: () => 'fixture',
        SECRET_KEYS: { MAKERSUITE: 'google', DEEPSEEK: 'deepseek', MISTRALAI: 'mistral', CLAUDE: 'claude' },
        GEMINI_SAFETY: [], VERTEX_SAFETY: [], enableSystemPromptCache: false, cachingAtDepth: -1, enableAdaptiveThinking: true,
        console: { info() {}, debug() {}, warn() {}, error() {} }, util: { inspect: () => '' },
        color: { red: String },
    };
    for (const name of ['convertGooglePrompt', 'convertClaudeMessages', 'convertMistralMessages',
        'calculateClaudeBudgetTokens', 'calculateGoogleBudgetTokens', 'addAssistantPrefix', 'addReasoningContentToToolCalls'])
        deps[name] = getHostConverter(name);
    deps.postProcessPrompt = getHostConverter('postProcessPrompt', { mergeMessages: getHostConverter('mergeMessages') });
    const asMessage = ({ role, content }) => ({ role, content });
    const cue = asMessage(preset.prompts.find(row => row.identifier === LIN_PROMPT_ID));
    const confirm = asMessage(preset.prompts.find(row => row.identifier === LIN_CONFIRM_ID));
    const request = { type: 'normal', stream: false, reasoning_effort: 'auto', include_reasoning: false,
        enable_web_search: false, max_tokens: 4000, use_sysprompt: true,
        messages: [{ role: 'system', content: '场景。' }, { role: 'user', content: '继续。' }, cue, confirm] };

    async function callHost(code, handler, outgoing, packet) {
        const calls = [];
        const run = hostFunction(code, handler, { ...deps,
            fetch: async (url, { body }) => {
                calls.push({ url: String(url), body: JSON.parse(body) });
                return Response.json(packet);
            },
        });
        const response = { code: 200, status(code) { this.code = code; return this; },
            send(value) { this.value = value; }, end() {} };
        await run({ body: structuredClone(outgoing), socket: new EventEmitter(), user: { directories: {} } }, response);
        assert.equal(response.code, 200, JSON.stringify(response.value));
        assert.equal(calls.length, 1);
        return { ...calls[0], reply: response.value };
    }
    for (const [channel, model, handler, flag] of [
        ['mistralai', 'mistral-large-latest', 'sendMistralAIRequest', true],
        ['deepseek', 'deepseek-v4-flash', 'sendDeepSeekRequest', true],
        ['claude', 'claude-haiku-4-5-20251001', 'sendClaudeRequest', false],
    ]) await t.test(channel, async () => {
        const outgoing = { ...request, model, chat_completion_source: channel };
        const plan = planInjection(outgoing, {}, { preset, activeOrderId: 100001 });
        assert.equal(plan.reason, 'prefill-converted');
        const packet = { choices: [{ message: { content: '正文。' } }], content: [{ type: 'text', text: '正文。' }],
            usage: { input_tokens: 61, output_tokens: 9 } };
        const sent = await callHost(patched, handler, { ...outgoing, messages: plan.messages }, packet);
        const last = sent.body.messages.at(-1);
        assert.equal(last.role, 'assistant');
        assert.equal(Array.isArray(last.content) ? last.content[0].text : last.content, cue.content);
        assert.equal(last.prefix, flag ? true : undefined);
        assert.equal(sent.body.max_tokens, 4000);
        assert.ok(JSON.stringify(sent.body.messages.slice(0, -1)).includes(JSON.stringify(confirm.content).slice(1, -1)));
        if (channel === 'deepseek') assert.match(sent.url, /api\.deepseek\.com\/beta\/chat\/completions$/);
        if (channel === 'claude') assert.deepEqual(sent.reply.usage, packet.usage);
    });
    await t.test('Carbon proxy preserves rules with and without declared prefill support', async () => {
        const outgoing = { ...request, chat_completion_source: 'vertexai', model: 'gemini-4-carbon',
            reverse_proxy: 'https://gateway.example', vertexai_auth_mode: 'proxy', enable_web_search: true };
        const packet = { candidates: [{ content: { role: 'model', parts: [{ text: '正文。' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 61, thoughtsTokenCount: 14, candidatesTokenCount: 9, totalTokenCount: 84 } };
        for (const declared of [false, true]) {
            const plan = planInjection(outgoing, { googleProxyPrefill: declared ? googleProxyKey(outgoing) : '' },
                { preset, activeOrderId: 100001 });
            assert.equal(plan.reason, declared ? 'prefill-converted' : 'prefill-unavailable');
            const input = { ...outgoing, messages: plan.messages };
            const stock = await callHost(source, 'sendMakerSuiteRequest', input, packet);
            const sent = await callHost(patched, 'sendMakerSuiteRequest', input, packet);
            assert.deepEqual(sent.body, stock.body);
            assert.equal(sent.body.contents.at(-1).role, declared ? 'model' : 'user');
            const rulesTurn = sent.body.contents.at(declared ? -2 : -1);
            assert.ok(rulesTurn.parts.some(part => part.text.includes(confirm.content)));
            assert.equal(sent.body.generationConfig.maxOutputTokens, 4000);
            assert.deepEqual(sent.body.tools, [{ google_search: {} }]);
            assert.equal(stock.reply.usageMetadata, undefined);
            assert.deepEqual(sent.reply.usageMetadata, packet.usageMetadata);
            const stats = { reasoningChars: 0 };
            addResponseData(stats, sent.reply);
            assert.deepEqual([stats.promptTokens, stats.thoughtTokens, stats.outputTokens, stats.totalTokens], [61, 14, 9, 84]);
            assert.equal(JSON.stringify(sent.reply.choices), JSON.stringify(stock.reply.choices));
        }
    });
});

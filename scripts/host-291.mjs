// Test fixture only: private local ST account; nothing here is imported by the extension.
const C='e898d676-f02e-4868-bc51-33761e294df6',U='68186c40-6f11-4c47-a036-58497d1d6795',N='b62baac5-e695-5ce5-899b-edc7989babc8';
const H='lin_prefill_guard_history_v2',KEY='lin_prefill_guard_v1';
export async function setup(p){
    let ctx=SillyTavern.getContext();
    if(ctx.characterId==null||ctx.getCurrentChatId()==null)await ctx.selectCharacterById(0,{switchMenu:false});
    ctx=SillyTavern.getContext();const oa=await import('/scripts/openai.js'),app=await import('/script.js');
    const s=ctx.chatCompletionSettings;
    Object.assign(s,p,{preset_settings_openai:p.name,chat_completion_source:'vertexai',vertexai_model:'gemini-4-carbon',google_model:'gemini-4-carbon',
        reverse_proxy:'',proxy_password:'',openai_max_context:250000,stream_openai:true,request_images:false,function_calling:false});
    app.changeMainAPI('openai');
    Object.assign(ctx.extensionSettings[KEY],{enabled:true,captureNetwork:true,storyMoreTokens:false,requestMode:'gemini4'});
    ctx.extensionSettings.human_temper_v1={...(ctx.extensionSettings.human_temper_v1||{}),enabled:false};
    const defs=Object.fromEntries(p.prompts.map(x=>[x.identifier,x]));
    const last=()=>JSON.parse(SillyTavern.getContext().accountStorage.getItem(H)||'[]').find(x=>x.origin==='assembled');
    window.qa291={ctx,p,s,oa,app,last,defs};
}
export async function assemble(id){
    const {p,s,oa,defs}=qa291,pm=oa.promptManager;pm.configuration.promptOrder.dummyId=id;pm.activeCharacter={id};
    const q={role:'user',content:'窗台上放着一把旧雨伞。接着写一个普通场景。'};
    const input={name2:'测试角色',charDescription:'',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',bias:'',type:'normal',quietPrompt:'',quietImage:'',extensionPrompts:{},cyclePrompt:'',systemPromptOverride:'',jailbreakPromptOverride:'',messages:[q],messageExamples:[]};
    const ms=(await oa.prepareOpenAIMessages(input,false))[0];
    const npc=ms.some(m=>m.role==='system'&&m.content===defs[N].content);
    if(!ms.some(m=>m.role==='user'&&m.content===q.content)||ms.at(-1)?.content!==defs[U].content||ms.at(-2)?.content!==defs[C].content)
        throw new Error('unexpected host tail');
    const closure=defs['99dd9277-7d27-40fb-972f-a009ae4983e9'];
    qa291.ms=ms;return {group:id,active:pm.getPromptOrderForCharacter({id}).filter(e=>e.enabled).length,npcOnWire:npc,
        closureOnWire:ms.some(m=>m.role==='system'&&m.content===closure.content),
        settingsIdentity:pm.serviceSettings===s,presetName:p.name};
}
function prefs(options){
    const {s,ctx}=qa291;
    Object.assign(s,{chat_completion_source:options.provider||'vertexai',reverse_proxy:'',proxy_password:'',
        enable_web_search:options.search!==false,google_model:'gemini-4-carbon',vertexai_model:'gemini-4-carbon',stream_openai:options.stream!==false,openai_max_tokens:16384});
    Object.assign(ctx.extensionSettings[KEY],{requestMode:options.mode||'gemini4',storyMoreTokens:!!options.cap});
}
export async function send(options){
    const {ctx,oa,ms,last}=qa291,type=options.type||'normal';prefs(options);
    let arr=structuredClone(ms);
    if(options.rev) [arr[arr.length-2],arr[arr.length-1]]=[arr.at(-1),arr.at(-2)];
    if(options.companion){
        // Public exported pure layout function of the unchanged companion, with a synthetic decision.
        const c=await import('/scripts/extensions/third-party/human-temper/controller.js');
        arr=c.boundary(arr,'〔人性阴暗面/情绪/随机性放大·角色演出〕 角色在窗边工作。');
    }
    const before=last()?.id;
    await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,type,{},false);
    // Capture exactly the JSON that would be sent, not JS properties whose
    // undefined values Playwright serializes as null but fetch omits.
    const capture=r=>{qa291.before=JSON.parse(JSON.stringify(r));};
    ctx.eventSource.makeFirst(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,capture);
    let visible='';
    try{
        const response=await oa.sendOpenAIRequest(type,arr,null);
        if(typeof response==='function'){for await(const snapshot of response()) visible=snapshot.text;}
        else visible=response?.choices?.[0]?.message?.content;
        for(let n=0;n<120&&(!last()?.wire?.responseComplete||last()?.id===before);n++)await new Promise(r=>setTimeout(r,10));
        return {visible,reason:last()?.reason,checked:last()?.dispatch?.linOrder||null,npc:last()?.lin291?.npcEnabled,group:last()?.lin291?.order,
            savedOrderKept:oa.promptManager.serviceSettings===qa291.s,version:last()?.version,terminal:last()?.wire?.finishReason??null};
    }finally{ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,capture);await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);}
}
export async function full(){
    const ctx=SillyTavern.getContext(),{app,last,defs}=qa291;
    await ctx.openCharacterChat('lin-291-local');
    prefs({mode:'gemini4-story'});ctx.extensionSettings.human_temper_v1={...ctx.extensionSettings.human_temper_v1,enabled:true,memory:false,unpredict:100,dark:100,intensity:100,eventRate:100};
    app.setOnlineStatus('loopback-test');
    const send=document.querySelector('#send_textarea');send.value='她把信放到了窗边。接着写这个场景。';send.dispatchEvent(new Event('input',{bubbles:true}));
    const beforeSend=SillyTavern.getContext().chat.filter(x=>x.is_user).length;
    const rows=[];for(const type of ['normal','regenerate','swipe']){
        if(type==='swipe')await app.swipe_right(null,{source:(await import('/scripts/constants.js')).SWIPE_SOURCE.KEYBOARD});
        else await ctx.generate(type);
        for(let i=0;i<140&&!last()?.wire?.responseComplete;i++)await new Promise(r=>setTimeout(r,12));
        const live=SillyTavern.getContext(),r=last();rows.push({type,reason:r?.reason,correlation:r?.dispatch?.correlation,checked:r?.dispatch?.linOrder,
            responseComplete:!!r?.wire?.responseComplete,stored:live.chat.at(-1)?.mes==='本地测试回复。',
            confirmationsInSavedChat:live.chat.filter(x=>x.mes===defs[U].content||x.mes===defs[C].content).length});
    }
    return {rows,userTurns:SillyTavern.getContext().chat.filter(x=>x.is_user).length-beforeSend};
}

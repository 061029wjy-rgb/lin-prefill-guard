import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, migrateSettings, planInjection } from '../core.js';
import { planReasoning } from '../diagnostics.js';
import { GUIDES, EFFECTS } from '../setting-help.js';
import { payload, preset } from '../fixtures/protocol.mjs';

test('each supported account preference has a setup and an example; both states of all switches are explained',()=>{
    assert.deepEqual(Object.keys(GUIDES).sort(),Object.keys(DEFAULTS).sort());
    for (const [key,initial] of Object.entries(DEFAULTS)) {
        const [how,example]=GUIDES[key];assert.ok(how.trim()&&example.trim()&&how!==example,key);
        if(typeof initial==='boolean')assert.ok(EFFECTS[key].on&&EFFECTS[key].off&&EFFECTS[key].on!==EFFECTS[key].off,key);
    }
});

test('saving the three legacy choices while observing neither activates enhancement nor overrides the 2.9 path',()=>{
    const options=migrateSettings({requestMode:'observe',scope:'all',mode:'pair',reasoningMode:'balanced'}), r=payload(), p=preset();
    const before=structuredClone(r);
    assert.equal(planInjection(r,options,{preset:p}).reason,'observe-only');
    assert.equal(planReasoning({...r,reasoning_effort:'high'},options),null);
    const twoNine=planInjection(r,{...options,requestMode:'enhance'},{preset:p});
    assert.equal(twoNine.reason,'290-ready');assert.equal(twoNine.changed,false);assert.deepEqual(twoNine.injected,[]);
    assert.deepEqual(r,before);
});

test('the practical examples match the legacy role layout, scope and high/auto reasoning choices',()=>{
    const r={type:'normal',model:'gemini-3-pro',reasoning_effort:'high',messages:[{role:'user',content:'接着写。'}]};
    const opt={...DEFAULTS,requestMode:'enhance',prefill:'接上一幕',nudge:'写出后续',reasoningMode:'balanced'};
    assert.equal(planInjection(r,opt,{preset:{}}).reason,'not-lin');
    const run=mode=>planInjection(r,{...opt,scope:'all',mode},{preset:{}});
    const one=run('user').injected,two=run('pair').injected;
    assert.deepEqual(one.map(x=>x.role),['user']);assert.match(one[0].content,/接上一幕[\s\S]*写出后续/);
    assert.deepEqual(two.map(x=>x.role),['assistant','user']);assert.match(two[0].content,/接上一幕/);assert.match(two[1].content,/写出后续/);
    assert.deepEqual(planReasoning(r,opt),{before:'high',after:'low'});
    assert.equal(planReasoning({...r,reasoning_effort:'auto'},opt),null);
    assert.equal(planReasoning({...r,model:'unidentified'},opt),null);
});

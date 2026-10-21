import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recordStatus, recordDiagnosis, profileMismatch, responseDiagnosis } from '../diagnostics.js';
import { deliveryCue, deliveryProfile, COT_ID } from '../delivery.js';
import { LIN_PROMPT_ID, LIN_24_PREFILL, planInjection } from '../core.js';

const profile = { known: true, orderKnown: true, cueEnabled: true, cotEnabled: false, sceneEnabled: true, components: [] };
test('provider SAFETY takes precedence over partial comment in status and summary', () => {
    const output = { cotCount: 1, cotChars: 608, nonCommentChars: 33, openComment: true, openTags: [] };
    const record = { wire: { finishReason: 'SAFETY', visibleChars: 642, doneMarker: true, responseComplete: true, output }, rendered: { chars: 642, output }, deliveryProfile: profile };
    assert.equal(recordStatus(record).label, '服务端限制');
    assert.match(recordDiagnosis(record).split('\n')[0], /SAFETY/);
    assert.match(recordDiagnosis(record), /未闭合/);
    assert.match(profileMismatch(record), /不一致/);
});
test('MAX_TOKENS is distinct from SAFETY and STOP', () => {
    assert.equal(recordStatus({wire:{finishReason:'MAX_TOKENS'}}).label,'输出预算结束');
    assert.equal(recordStatus({wire:{finishReason:'STOP'}}).label,'已收到结束原因');
});
test('DONE without finish reason is not a proven successful response', () => {
    const wire = { responseComplete: true, recognized: true, visibleChars: 205, doneMarker: true };
    assert.equal(recordStatus({wire}).label,'结束原因未知');
    assert.match(responseDiagnosis(wire), /DONE只说明流已结束/);
    assert.doesNotMatch(responseDiagnosis(wire), /安全拦截|达到输出上限/);
});
test('dispatch without wire remains pending evidence, not diagnosed truncation', () => {
    assert.equal(recordStatus({dispatch:{verified:true}}).label,'等待结束证据');
});
test('unknown component list does not disable components or mandate absent CoT', () => {
    const cue = deliveryCue(profile);
    assert.doesNotMatch(cue,/当前启用组件|无附加组件|剧情停在交互节点|500汉字/);
    assert.match(cue,/若本轮实际要求/);
    assert.match(cue,/若无此要求，不新增注释/);
    assert.match(cue,/不将插件识别到的条目视为完整清单/);
});
test('profile mismatch requires observed CoT, not merely a short reply', () => {
    assert.equal(profileMismatch({deliveryProfile:profile,wire:{output:{cotCount:0}}}), '');
});
test('2.6.3 revision and replaced CoT ID use conditional delivery without mutating preset', () => {
    const prompts = [{identifier:LIN_PROMPT_ID,role:'assistant',content:LIN_24_PREFILL},
        {identifier:'replacement-cot',role:'system',content:'本条将Lin2.6.3实际启用的规则汇总。'}];
    const preset = {prompts,prompt_order:[{character_id:100001,order:prompts.map(p=>({identifier:p.identifier,enabled:true}))}]};
    const before = JSON.stringify(preset);
    assert.equal(deliveryProfile(preset).known,true);
    const req = {messages:[{role:'user',content:'写一段日常。'},{role:'assistant',content:LIN_24_PREFILL}],max_tokens:16384,reasoning_effort:'auto'};
    const result = planInjection(req,{}, {preset});
    assert.equal(result.deliveryGuard,true);
    assert.match(result.messages.at(-1).content,/若本轮实际要求/);
    assert.equal(JSON.stringify(preset),before);
    assert.equal(req.max_tokens,16384);
    assert.equal(req.reasoning_effort,'auto');
});
test('disabled known CoT does not activate fixed-column instructions', () => {
    assert.doesNotMatch(deliveryCue({...profile,cotEnabled:false}),/保留原有栏目|13项/);
    assert.match(deliveryCue({...profile,cotEnabled:true}),/500汉字/);
});
test('actual 2026-10-21 log regression (no private log bundled)', {skip:!process.env.LIN_HISTORY_PATH}, () => {
    const records = JSON.parse(fs.readFileSync(process.env.LIN_HISTORY_PATH,'utf8')).records;
    const before = JSON.stringify(records);
    const lin = records.filter(r=>r.applied);
    assert.equal(lin.length,10);
    assert.equal(lin.filter(r=>r.wire?.finishReason==='SAFETY').length,2);
    assert.equal(lin.filter(r=>r.wire?.finishReason==='STOP').length,6);
    for(const r of lin){
        const status=recordStatus(r);
        if(r.wire?.finishReason==='SAFETY'){
            assert.equal(status.label,'服务端限制');
            assert.match(recordDiagnosis(r).split('\n')[0],/SAFETY/);
        }
        if(r.wire?.output?.cotCount)assert.match(profileMismatch(r),/不一致/);
        if(r.wire&&r.rendered)assert.equal(r.wire.visibleChars,r.rendered.chars);
    }
    assert.equal(JSON.stringify(records),before);
});

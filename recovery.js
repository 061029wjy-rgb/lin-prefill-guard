import { hasServiceRestriction } from './diagnostics.js?v=1.2.7';
import { analyzeOutput } from './structure.js?v=1.2.7';

/** Explicit user-click actions only. No timers, retries, direct API calls or chat edits. */
export function createRecovery({ getContext, getRecord = () => null, isBusy = () => false, hasDraft = () => false }) {
    let targets = new WeakMap();
    let running = false;
    function unavailable(ctx) {
        if (running || isBusy() || (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished && !ctx.streamingProcessor.isStopped))
            return '生成仍在进行，请结束当前生成后再检查。';
        if (ctx.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '')
            return '群聊请使用酒馆原生操作，以保留发言者与轮次选择。';
        if (ctx.mainApi && ctx.mainApi !== 'openai') return '此入口仅用于 Chat Completion；其他连接使用酒馆原生操作。';
        if (typeof ctx.generate !== 'function') return '当前分支未提供原生生成接口，请使用酒馆自带的继续或重新生成。';
        if (hasDraft()) return '输入框有未发送内容，请先自行保存或处理，再进行补全或重生成。';
        return '';
    }
    function prepare() {
        const ctx = getContext();
        const reason = unavailable(ctx);
        if (reason) return { ok: false, message: reason };
        const message = ctx.chat?.at(-1);
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string')
            return { ok: false, message: '当前最后一条不是可操作的模型回复，请使用酒馆原生发送。' };
        const record = getRecord(ctx.chat, message);
        if (hasServiceRestriction(record?.wire) || record?.wire?.refusal)
            return { ok: false, message: '当前回复含接口明确限制或拒绝标志；此入口不用于重试该限制。请先检查原任务与服务商提示。' };
        const output = analyzeOutput(message.mes);
        const plan = { ok: true, canContinue: !!message.mes.trim(),
            message: !message.mes.trim() ? '当前回复没有文本，可选择重生成。'
                : output.onlyNotes ? '当前只有注释或思考，可补全后续正文；也可选择重生成。'
                : '确认当前回复确实未完时选择补全；需要重新回答时选择重生成。不会自动判断剧情是否完整。' };
        targets.set(plan, { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId,
            message, text: message.mes, swipe: message.swipe_id, length: ctx.chat.length });
        return plan;
    }
    async function run(plan, action) {
        const target = targets.get(plan);
        if (!target || !['continue', 'regenerate'].includes(action))
            return { ok: false, message: '检查结果已失效，请重新检查当前回复。' };
        const ctx = getContext(), reason = unavailable(ctx);
        if (reason) return { ok: false, message: reason };
        if (ctx.chat !== target.chat || ctx.chatId !== target.chatId || ctx.characterId !== target.characterId
            || ctx.chat.length !== target.length || ctx.chat.at(-1) !== target.message
            || target.message.mes !== target.text || target.message.swipe_id !== target.swipe)
            return { ok: false, message: '聊天、回复内容或所选版本已改变，请重新检查；未发送请求。' };
        if (action === 'continue' && !plan.canContinue)
            return { ok: false, message: '空回复没有可承接的文本，请选择重生成。' };
        // Recheck late-arriving transport evidence immediately before invoking the host.
        const record = getRecord(ctx.chat, target.message);
        if (hasServiceRestriction(record?.wire) || record?.wire?.refusal)
            return { ok: false, message: '接口刚返回了限制或拒绝标志，未发起补全或重生成。' };
        targets = new WeakMap();
        running = true;
        try {
            await ctx.generate(action);
            return { ok: true, message: '本次酒馆生成操作已结束，请核对回复与新诊断。未自动追加其他操作。' };
        } catch {
            return { ok: false, message: '酒馆生成未完成，请查看酒馆原错误提示。未自动再次调用。' };
        } finally { running = false; }
    }
    return { prepare, run, invalidate() { targets = new WeakMap(); } };
}

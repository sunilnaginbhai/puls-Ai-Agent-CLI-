import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createExecutionState, trimConversation, recoverConversation } from '../../agent/conversation.js';
import { SYSTEM_PROMPT } from '../../agent/session.js';
import { contentToMarkdown } from '../../ui/markdown.js';
import { getProviderApiKey } from '../../providers/provider.manager.js';
import { formatError } from '../../ui/error-format.js';
import { registerSecret, sanitizeOutput } from '../../ui/sanitize.js';
import { setTimeout as delay } from 'node:timers/promises';

export class TelegramRuntime {
    constructor({ client, allowedUserIds, providerConfig, offset = 0, saveOffset = async () => {}, graphFactory,
        prepareModel = () => getProviderApiKey({ config: providerConfig }) }) {
        this.client = client; this.allowed = new Set(allowedUserIds.map(String)); this.config = providerConfig;
        this.offset = offset; this.saveOffset = saveOffset; this.graphFactory = graphFactory; this.prepareModel = prepareModel;
        this.sessions = new Map(); this.status = 'Disconnected';
    }
    start() {
        if (this.task) return;
        this.controller = new AbortController();
        this.status = 'Connecting';
        this.task = this.poll(this.controller.signal).catch(() => { this.status = 'Connection stopped'; });
    }
    async stop() {
        this.controller?.abort();
        await this.task;
        this.task = undefined; this.sessions.clear(); this.status = 'Disconnected';
    }
    async poll(signal) {
        let failures = 0;
        while (!signal.aborted) {
            try {
                const updates = await this.client.call('getUpdates', { offset: this.offset, timeout: 25, limit: 20, allowed_updates: ['message'] }, signal);
                this.status = 'Connected'; failures = 0;
                for (const update of updates) {
                    signal.throwIfAborted();
                    if (!Number.isSafeInteger(update.update_id) || update.update_id < this.offset) continue;
                    this.offset = update.update_id + 1;
                    // A delivery error must never rerun an already executed agent turn.
                    await this.saveOffset(this.offset);
                    await this.handle(update, signal);
                }
            } catch (error) {
                if (signal.aborted) break;
                if ([401,403,409].includes(error.code)) {
                    this.status = error.code === 409 ? 'Conflict: stop the other bot poller or remove its webhook' : 'Authentication failed: reconfigure Telegram';
                    break;
                }
                this.status = 'Reconnecting';
                const wait = Math.max((error.retryAfter || 0) * 1000, Math.min(60000, 1000 * 2 ** Math.min(failures++, 5)));
                try { await delay(wait, undefined, { signal }); } catch { break; }
            }
        }
    }
    async handle(update, signal) {
        const message = update.message;
        if (!message || message.chat?.type !== 'private' || !this.allowed.has(String(message.from?.id)) || message.from?.is_bot) return;
        if (typeof message.text !== 'string') return;
        const chatId = message.chat.id, userId = String(message.from.id);
        const text = message.text.trim();
        if (!text) return;
        const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
        if (command === '/start' || command === '/help') return this.client.send(chatId, 'Puls AI connected. Send a question or coding task.\n/help — commands\n/status — connection and model\n/reset — clear your conversation\nWorkspace access is read-only on Telegram. Use the CLI for approved file changes.', signal);
        if (command === '/status') return this.client.send(chatId, `Telegram: ${this.status}\nModel: ${this.config.model}\nConversation turns: ${this.sessions.get(userId)?.turns || 0}`, signal);
        if (command === '/reset') { this.sessions.delete(userId); return this.client.send(chatId, 'Your conversation was reset.', signal); }
        if (text.startsWith('/')) return this.client.send(chatId, 'Unknown command. Use /help.', signal);
        if (text.length > 16000) return this.client.send(chatId, 'Please send a smaller request (up to 16,000 characters).', signal);
        const now = Date.now();
        for (const [id, session] of this.sessions) if (now - session.updated > 3600000) this.sessions.delete(id);
        if (!this.sessions.has(userId) && this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value);
        const session = this.sessions.get(userId) || { messages: [new SystemMessage(SYSTEM_PROMPT)], turns: 0 };
        session.messages = trimConversation([...session.messages, new HumanMessage(sanitizeOutput(text))]);
        session.updated = now; this.sessions.set(userId, session);
        const completedTools = [];
        try {
            const apiKey = await this.prepareModel(signal);
            registerSecret(apiKey);
            session.messages.at(-1).content = sanitizeOutput(session.messages.at(-1).content);
            signal?.throwIfAborted();
            this.graph ??= this.graphFactory ? await this.graphFactory() : (await import('../../agent/agent.graph.js')).createAgentGraph();
            const states = await this.graph.stream({ messages: session.messages }, {
                streamMode: 'values', recursionLimit: 26, signal,
                configurable: { apiKey, providerConfig: this.config, toolPolicy: 'read-only', execution: createExecutionState(),
                    askPermission: async () => false, onToolResult: (result) => completedTools.push(result) },
            });
            for await (const state of states) session.messages = state.messages;
            session.turns++;
        } catch (error) {
            session.messages = recoverConversation(session.messages, completedTools);
            if (signal?.aborted) throw error;
            const safe = formatError(error);
            return this.client.send(chatId, `${safe.title}\n${safe.message}\n${safe.nextStep || ''}`, signal);
        }
        await this.client.send(chatId, contentToMarkdown(session.messages.at(-1)?.content), signal);
    }
}

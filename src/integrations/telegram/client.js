import { registerSecret, sanitizeOutput } from '../../ui/sanitize.js';

export class TelegramError extends Error {
    constructor(code, retryAfter) { super(`Telegram request failed (${code}).`); this.code = code; this.retryAfter = retryAfter; }
}
export class TelegramClient {
    constructor(token, { fetchImpl = fetch, baseUrl = 'https://api.telegram.org' } = {}) {
        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Invalid Telegram bot token format. Copy the token from BotFather.');
        this.token = token; this.fetch = fetchImpl; this.baseUrl = baseUrl; registerSecret(token);
    }
    async call(method, body = {}, signal) {
        try {
            const response = await this.fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after);
            return data.result;
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (error instanceof TelegramError) throw error;
            throw new TelegramError('NETWORK');
        }
    }
    async send(chatId, text, signal) {
        const safe = sanitizeOutput(text) || '(Empty response)';
        // Split on Unicode code points, keeping each Telegram message below 4096 units.
        let chunk = '';
        for (const character of safe) {
            if ((chunk + character).length > 4000) { await this.call('sendMessage', { chat_id: chatId, text: chunk }, signal); chunk = ''; }
            chunk += character;
        }
        if (chunk) await this.call('sendMessage', { chat_id: chatId, text: chunk }, signal);
    }
}

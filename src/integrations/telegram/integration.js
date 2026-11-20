import { getSettingsFile, updateSettings } from '../../config/settings.store.js';
import { TokenVault } from './vault.js';
import { TelegramClient } from './client.js';
import { TelegramRuntime } from './runtime.js';

export function parseUserIds(text) {
    const ids = [...new Set(String(text).split(/[\s,]+/).filter(Boolean))];
    if (!ids.length || ids.length > 20 || ids.some((id) => !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error('Enter 1–20 positive numeric Telegram user IDs, separated by commas.');
    return ids;
}
export class TelegramIntegration {
    constructor({ input, output = process.stdout, providerConfig, vault = new TokenVault(), clientFactory = (token) => new TelegramClient(token), runtimeFactory = (options) => new TelegramRuntime(options), readSettings = getSettingsFile, saveSettings = updateSettings }) {
        Object.assign(this, { input, output, providerConfig, vault, clientFactory, runtimeFactory, readSettings, saveSettings });
    }
    status() { return this.runtime?.status || 'Not connected'; }
    async onboard() {
        const settings = await this.readSettings();
        if (settings.telegram?.configured || !this.input.isInteractive) return;
        this.output.write('\nTelegram is optional. Choose Skip to continue normally.\n');
        const answer = String(await this.input.question('Connect Telegram Bot? (Y/n) — n or Skip to skip: ')).trim().toLowerCase();
        if (['n','no','skip'].includes(answer)) {
            await this.saveSettings((s) => ({ ...s, telegram: { configured: true, enabled: false } }));
            this.output.write('Telegram skipped.\n'); return;
        }
        if (answer && !['y','yes'].includes(answer)) { this.output.write('Telegram skipped. Connect later with /telegram connect.\n'); return; }
        await this.configure();
    }
    async configure() {
        if (!this.input.isInteractive) throw new Error('Configure Telegram in an interactive terminal.');
        const token = String(await this.input.question('Telegram bot token (hidden; from BotFather): ', { secret: true })).trim();
        const client = this.clientFactory(token);
        const bot = await client.call('getMe');
        if (!bot?.is_bot || !bot.username) throw new Error('This token did not identify a Telegram bot.');
        const hook = await client.call('getWebhookInfo');
        if (hook?.url) throw new Error('This bot has a webhook. Remove it in the existing bot deployment before connecting Puls polling.');
        const allowedUserIds = parseUserIds(await this.input.question('Authorized Telegram user IDs (comma-separated; required): '));
        const secret = await this.vault.seal(token);
        await this.stop();
        // Skip messages queued before this explicit connection, rather than executing old tasks.
        const pending = await client.call('getUpdates', { offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] });
        const offset = pending.length ? pending.at(-1).update_id + 1 : 0;
        await this.saveSettings((s) => ({ ...s, telegram: { configured: true, enabled: true, secret, allowedUserIds, username: bot.username, offset } }));
        this.output.write('Telegram bot validated and credentials encrypted.\n');
        await this.start();
    }
    async start() {
        if (this.runtime) return;
        const config = (await this.readSettings()).telegram;
        if (!config?.enabled) return;
        const allowedUserIds = parseUserIds(config.allowedUserIds?.join(','));
        const token = await this.vault.open(config.secret);
        this.runtime = this.runtimeFactory({ client: this.clientFactory(token), allowedUserIds, providerConfig: this.providerConfig,
            offset: config.offset || 0, saveOffset: (offset) => this.saveSettings((s) => ({ ...s, telegram: { ...s.telegram, offset } })) });
        this.runtime.start();
    }
    async stop() { await this.runtime?.stop(); this.runtime = undefined; }
    async command(action = 'status') {
        action = action.trim().toLowerCase() || 'status';
        if (action === 'status') { this.output.write(`Telegram: ${this.status()}\n`); return; }
        if (action === 'connect' || action === 'reconfigure') { await this.configure(); return; }
        if (action === 'disconnect') {
            await this.stop();
            await this.saveSettings((s) => ({ ...s, telegram: { configured: true, enabled: false } }));
            this.output.write('Telegram disconnected; saved bot token removed.\n'); return;
        }
        throw new Error('Use /telegram status, connect, disconnect, or reconfigure.');
    }
}

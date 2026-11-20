import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config/paths.js';
import { COMMAND_NAMES, matchCommands } from './commands.js';
import { CommandMenu } from './command-menu.js';
import { sanitizeOutput } from './sanitize.js';

export const COMMANDS = COMMAND_NAMES;
export function completeCommand(line) {
    return [/^\/[\w-]*$/.test(line) ? matchCommands(line).map((command) => command.name) : [], line];
}

export function inputError(code = 'ERR_INPUT_NOT_OPEN') {
    return Object.assign(new Error(code === 'INPUT_CANCELLED' ? 'Input cancelled.' : 'Input stream closed.'), { code });
}

/** One lazy readline owner. Piped lines are queued so fast producers cannot lose input. */
export class TerminalInput extends EventEmitter {
    constructor({ input = process.stdin, output = process.stdout, historyFile = path.join(CONFIG_DIR, 'history.json'), maxQueuedBytes = 1024 * 1024, maxQueuedLines = 1024, maxLineBytes = 1024 * 1024 } = {}) {
        super();
        this.input = input;
        this.output = output;
        this.historyFile = historyFile;
        this.isInteractive = Boolean(input.isTTY && output.isTTY);
        this.lines = [];
        this.queuedBytes = 0;
        this.maxQueuedBytes = maxQueuedBytes;
        this.maxQueuedLines = maxQueuedLines;
        this.maxLineBytes = maxLineBytes;
        this.closed = false;
        this.history = [];
        this.historyWrite = Promise.resolve();
    }

    async initialize() {
        if (this.initializing) return this.initializing;
        this.initializing = this.open();
        return this.initializing;
    }

    async open() {
        if (this.closed) throw inputError();
        if (this.isInteractive && this.historyFile) {
            try {
                const saved = JSON.parse(await fs.readFile(this.historyFile, 'utf8'));
                if (Array.isArray(saved)) this.history = saved.filter((line) => COMMANDS.includes(line)).slice(0, 100);
            } catch (error) {
                if (error.code !== 'ENOENT') this.emit('historyWarning', error);
            }
        }
        if (this.closed) throw inputError();
        if (!this.isInteractive) {
            // Enforce a line bound before readline accumulates an entire pipe
            // that never sends a newline. Keep only a byte count, not a copy.
            let lineBytes = 0;
            this.guardInput = (chunk) => {
                const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                for (const byte of bytes) {
                    lineBytes = byte === 10 || byte === 13 ? 0 : lineBytes + 1;
                    if (lineBytes > this.maxLineBytes) {
                        this.fail(Object.assign(new Error('Input line limit exceeded. Split the request into smaller lines.'), { code: 'ERR_INPUT_LIMIT' }));
                        return;
                    }
                }
            };
            this.input.on('data', this.guardInput);
        }
        this.richInput = process.env.TERM !== 'dumb';
        this.interface = createInterface({
            input: this.input, output: this.output, terminal: this.isInteractive,
            completer: completeCommand, history: this.history, historySize: 100,
            removeHistoryDuplicates: true, crlfDelay: Infinity,
        });
        if (this.isInteractive) {
            this.menu = new CommandMenu({ output: this.output, readline: this.interface });
            // Readline has no public key filter; keep background typing from
            // repainting the prompt over a running response. Prompts still work.
            const ttyWrite = this.interface._ttyWrite;
            this.ttyWrite = ttyWrite;
            this.interface._ttyWrite = (data, key) => {
                this.menu.hide();
                if (this.busy && !this.pending) {
                    if (key?.ctrl && key.name === 'c') this.emit('cancel');
                    if (key?.ctrl && key.name === 'd') { this.emit('cancel'); void this.close(); }
                    return;
                }
                const showing = this.canShowMenu() && !this.menuDismissed;
                if (showing && ['up', 'down'].includes(key?.name)) {
                    const matches = this.commandMatches();
                    if (matches.length) {
                        this.menuIndex = ((this.menuIndex ?? 0) + (key.name === 'down' ? 1 : -1) + matches.length) % matches.length;
                        this.refreshMenu();
                        return;
                    }
                }
                if (showing && key?.name === 'escape') {
                    this.menuDismissed = true;
                    return;
                }
                if (showing && ['return', 'enter', 'tab'].includes(key?.name)) {
                    const command = this.commandMatches()[this.menuIndex ?? 0];
                    if (command) {
                        this.replaceLine(`${command.name}${command.acceptsArgs ? ' ' : ''}`);
                        this.menuDismissed = true;
                        if (key.name === 'tab' || (command.acceptsArgs && !command.optionalArgs)) return;
                    }
                }
                const before = this.interface.line;
                ttyWrite.call(this.interface, data, key);
                if (this.interface.line !== before) {
                    this.menuDismissed = false;
                    this.menuIndex = 0;
                }
                this.refreshMenu();
            };
            this.resizeHandler = () => this.refreshMenu();
            this.output.on?.('resize', this.resizeHandler);
        }
        this.interface.on('line', (line) => {
            if (this.pending) this.settle(null, line);
            else if (!this.isInteractive || this.readingInput) this.enqueue(line);
        });
        this.interface.on('SIGINT', () => {
            this.interface.write(null, { ctrl: true, name: 'u' });
            this.interface.write(null, { ctrl: true, name: 'k' });
            if (!this.richInput) { this.interface.line = ''; this.interface.cursor = 0; }
            this.output.write('\n');
            this.emit('cancel');
            if (this.pending) this.settle(inputError('INPUT_CANCELLED'));
        });
        this.interface.on('close', () => {
            this.menu?.hide();
            this.closed = true;
            if (this.guardInput) this.input.off('data', this.guardInput);
            if (this.resizeHandler) this.output.off?.('resize', this.resizeHandler);
            if (this.pending) this.settle(inputError());
            this.emit('close');
        });
        this.interface.on('error', (error) => this.fail(error));
    }

    enqueue(line) {
        if (this.failure) return;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (this.lines.length >= this.maxQueuedLines || this.queuedBytes + bytes > this.maxQueuedBytes) {
            this.fail(Object.assign(new Error('Input buffer limit exceeded. Split piped or pasted input into smaller batches.'), { code: 'ERR_INPUT_LIMIT' }));
            return;
        }
        this.lines.push(line);
        this.queuedBytes += bytes;
    }

    fail(error) {
        this.failure = error;
        this.lines = [];
        this.queuedBytes = 0;
        this.settle(error);
        this.interface?.close();
    }

    clearLine() {
        this.menu?.hide();
        if (!this.interface) return;
        this.interface.line = '';
        this.interface.cursor = 0;
        this.selection = undefined;
        this.menuIndex = 0;
        this.menuDismissed = false;
    }

    canShowMenu() {
        return this.isInteractive && this.richInput && !this.secret && this.pending?.buffered
            && /^\/[\w-]*$/.test(this.interface.line);
    }

    commandMatches() {
        const line = this.interface.line.toLowerCase();
        const followups = (this.followups ?? []).map((item, index) => ({
            name: `/${index + 1}`, description: item.label, kind: 'prompt', acceptsArgs: false,
        })).filter((command) => command.name.startsWith(line));
        return [...matchCommands(line), ...followups];
    }

    refreshMenu() {
        this.menu?.hide();
        if (!this.canShowMenu() || this.menuDismissed) return;
        const matches = this.commandMatches();
        this.menuIndex = Math.min(this.menuIndex ?? 0, Math.max(0, matches.length - 1));
        this.menu.render(matches, this.menuIndex);
    }

    replaceLine(text) {
        this.menu?.hide();
        this.ttyWrite.call(this.interface, null, { ctrl: true, name: 'u' });
        this.ttyWrite.call(this.interface, null, { ctrl: true, name: 'k' });
        this.ttyWrite.call(this.interface, text, {});
    }

    setDraft(text) {
        if (!this.isInteractive) return false;
        const draft = sanitizeOutput(text).replace(/\n/g, ' ');
        if (Buffer.byteLength(draft, 'utf8') > this.maxLineBytes) return false;
        this.draft = draft;
        return true;
    }

    setFollowups(items = []) {
        this.followups = items.slice(0, 3);
        this.refreshMenu();
    }

    settle(error, answer) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
        this.menu?.hide();
        pending.cleanup();
        if (error) pending.reject(error);
        else pending.resolve(answer);
    }

    async question(prompt = '', { signal, secret = false, buffered = false } = {}) {
        signal?.throwIfAborted();
        await this.initialize();
        signal?.throwIfAborted();
        if (this.failure) throw this.failure;
        if (this.pending) throw new Error('Another input prompt is already active.');
        if (this.lines.length && (!this.isInteractive || (buffered && !secret))) {
            const line = this.lines.shift();
            this.queuedBytes = Math.max(0, this.queuedBytes - Buffer.byteLength(line, 'utf8'));
            // Fresh pasted input supersedes a suggestion selected earlier.
            // Do not resurrect that old draft after the queued request runs.
            if (this.isInteractive && buffered) this.draft = undefined;
            return line;
        }
        if (this.closed) throw inputError();
        if (this.isInteractive) {
            // Approval and credential prompts require fresh input. A pasted
            // command must never become an answer to a later consent prompt.
            if (!buffered || secret) this.clearLine();
            this.interface.setPrompt(prompt);
            this.interface.prompt();
        }
        const originalWrite = this.interface._writeToOutput;
        const originalHistory = secret ? [...(this.interface.history ?? [])] : undefined;
        this.secret = secret;
        if (secret && this.isInteractive) this.interface._writeToOutput = () => {};
        try {
            return await new Promise((resolve, reject) => {
                const abort = () => this.settle(signal.reason ?? inputError('INPUT_CANCELLED'));
                this.pending = { resolve, reject, buffered, cleanup: () => signal?.removeEventListener('abort', abort) };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
                if (buffered && !secret && this.draft != null && this.pending) {
                    const draft = this.draft;
                    this.draft = undefined;
                    if (this.richInput) this.replaceLine(draft);
                    else {
                        this.interface.line = draft;
                        this.interface.cursor = draft.length;
                        this.interface._writeToOutput(draft);
                    }
                    this.menuDismissed = false;
                    this.menuIndex = 0;
                    this.refreshMenu();
                }
            });
        } finally {
            this.secret = false;
            if (secret && this.isInteractive) {
                this.clearLine();
                this.interface.history = originalHistory;
                this.interface._writeToOutput = originalWrite;
                this.output.write('\n');
            }
        }
    }

    async readInput(prompt = 'you › ', options = {}) {
        if (this.readingInput) throw new Error('Another input request is already active.');
        this.readingInput = true;
        const parts = [];
        let accumulatedBytes = 0;
        try {
            while (true) {
                let line;
                try {
                    line = await this.question(parts.length ? '  … › ' : prompt, { ...options, buffered: true });
                    if (this.failure) throw this.failure;
                } catch (error) {
                    if (!this.isInteractive && parts.length && error?.code === 'ERR_INPUT_NOT_OPEN') break;
                    throw error;
                }
                const continued = /(?<!\\)(?:\\\\)*\\$/.test(line);
                const part = continued ? line.slice(0, -1) : line;
                accumulatedBytes += Buffer.byteLength(part, 'utf8') + (parts.length ? 1 : 0);
                if (accumulatedBytes > this.maxQueuedBytes) {
                    this.fail(Object.assign(new Error('Multiline input limit exceeded. Split the request into smaller batches.'), { code: 'ERR_INPUT_LIMIT' }));
                    throw this.failure;
                }
                parts.push(part);
                if (!continued) break;
            }
        } finally {
            this.readingInput = false;
        }
        const result = parts.join('\n');
        const command = result.trim().split(/\s/, 1)[0].toLowerCase();
        // Persist commands only; prompts can contain source code and credentials.
        if (this.isInteractive && this.historyFile && COMMANDS.includes(command)) {
            this.history = [command, ...this.history.filter((entry) => entry !== command)].slice(0, 100);
            const data = JSON.stringify(this.history);
            this.historyWrite = this.historyWrite.then(async () => {
                await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
                await fs.writeFile(this.historyFile, data, { mode: 0o600 });
            }).catch((error) => this.emit('historyWarning', error));
        }
        return result;
    }

    setBusy(busy) { this.menu?.hide(); this.busy = busy; }

    async close() {
        this.closed = true;
        this.interface?.close();
        if (this.pending) this.settle(inputError());
        await this.historyWrite;
    }
}

const rl = new TerminalInput();
export default rl;

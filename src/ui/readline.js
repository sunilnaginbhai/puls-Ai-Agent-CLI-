import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config/paths.js';

export const COMMANDS = ['/help', '/status', '/clear', '/bye'];
export function completeCommand(line) {
    const matches = COMMANDS.filter((command) => command.startsWith(line.toLowerCase()));
    return [line.startsWith('/') ? matches : [], line];
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
            // Readline has no public key filter; keep background typing from
            // repainting the prompt over a running response. Prompts still work.
            const ttyWrite = this.interface._ttyWrite;
            this.interface._ttyWrite = (data, key) => {
                if (this.busy && !this.pending) {
                    if (key?.ctrl && key.name === 'c') this.emit('cancel');
                    if (key?.ctrl && key.name === 'd') { this.emit('cancel'); void this.close(); }
                    return;
                }
                if (this.richInput && !this.secret && ['up', 'down'].includes(key?.name) && this.interface.line.startsWith('/')) {
                    const prefix = this.selection?.prefix ?? this.interface.line.toLowerCase();
                    const matches = COMMANDS.filter((command) => command.startsWith(prefix));
                    if (matches.length) {
                        const index = ((this.selection?.index ?? (key.name === 'down' ? -1 : 0)) + (key.name === 'down' ? 1 : -1) + matches.length) % matches.length;
                        this.selection = { prefix, index };
                        ttyWrite.call(this.interface, null, { ctrl: true, name: 'u' });
                        ttyWrite.call(this.interface, null, { ctrl: true, name: 'k' });
                        ttyWrite.call(this.interface, matches[index], {});
                        return;
                    }
                }
                this.selection = undefined;
                ttyWrite.call(this.interface, data, key);
            };
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
            this.closed = true;
            if (this.guardInput) this.input.off('data', this.guardInput);
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
        if (!this.interface) return;
        this.interface.line = '';
        this.interface.cursor = 0;
        this.selection = undefined;
    }

    settle(error, answer) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
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
        if (this.lines.length && (!this.isInteractive || buffered)) {
            const line = this.lines.shift();
            this.queuedBytes = Math.max(0, this.queuedBytes - Buffer.byteLength(line, 'utf8'));
            return line;
        }
        if (this.closed) throw inputError();
        if (this.isInteractive) {
            // Approval and credential prompts require fresh input. A pasted
            // command must never become an answer to a later consent prompt.
            if (!buffered) this.clearLine();
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
                this.pending = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
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
        const command = result.trim().toLowerCase();
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

    setBusy(busy) { this.busy = busy; }

    async close() {
        this.closed = true;
        this.interface?.close();
        if (this.pending) this.settle(inputError());
        await this.historyWrite;
    }
}

const rl = new TerminalInput();
export default rl;

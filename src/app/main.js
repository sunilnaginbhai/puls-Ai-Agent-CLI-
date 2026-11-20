import path from 'node:path';
import fs from 'node:fs/promises';
import rl, { inputError } from '../ui/readline.js';
import { createTerminal, registerSecret } from '../ui/terminal.js';
import { stopSpinner, pauseSpinner, resumeSpinner } from '../ui/spinner.js';
import { getProviderConfig } from '../providers/provider.config.js';
import { ensureProviderApiKey } from '../providers/provider.manager.js';

export default async function main({ args = process.argv.slice(2) } = {}) {
    if (args.includes('--no-color')) process.env.NO_COLOR = '1';
    const terminal = createTerminal();
    if (args.includes('--help') || args.includes('-h')) {
        terminal.notice('Puls AI · local coding assistant\nUsage: puls-ai [--help] [--version] [--no-color]');
        terminal.help();
        return;
    }
    if (args.includes('--version') || args.includes('-v')) {
        const metadata = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
        terminal.notice(metadata.version);
        return;
    }
    const unknown = args.filter((arg) => arg !== '--no-color');
    if (unknown.length) {
        terminal.error(new Error(`Unknown argument: ${unknown[0]}. Use --help for usage.`));
        process.exitCode = 2;
        return;
    }
    let apiKey;
    const interrupt = () => {
        rl.emit('cancel');
        rl.settle(inputError('INPUT_CANCELLED'));
    };
    const terminate = () => { process.exitCode = 143; rl.emit('cancel'); void rl.close(); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
        const config = getProviderConfig();
        const workspace = await fs.realpath(path.resolve(process.env.PULS_AI_WORKSPACE || process.cwd()));
        if (!(await fs.stat(workspace)).isDirectory()) throw new Error('PULS_AI_WORKSPACE must point to a directory.');
        if (rl.isInteractive) terminal.welcome({ ...config, provider: config.label, workspace });
        // Command-only sessions do not load LangGraph or make authentication requests.
        const { default: initializeGraph } = await import('../agent/session.js');
        await initializeGraph({
            providerConfig: config, workspace,
            prepareModel: async (signal) => {
                signal.throwIfAborted();
                apiKey ??= await ensureProviderApiKey(
                    async ({ label }) => {
                        const resume = pauseSpinner();
                        try { return await rl.question(`${label} API key (hidden): `, { secret: true, signal }); }
                        finally { if (resume && !signal.aborted) resumeSpinner(); }
                    },
                    { config, interactive: rl.isInteractive, signal },
                );
                registerSecret(apiKey);
                signal.throwIfAborted();
                return { apiKey };
            },
        });
    } catch (error) {
        if (!['ERR_INPUT_NOT_OPEN', 'ERR_USE_AFTER_CLOSE', 'INPUT_CANCELLED'].includes(error?.code)) {
            terminal.error(error);
            process.exitCode = 1;
        }
    } finally {
        stopSpinner();
        await rl.close();
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
    }
}

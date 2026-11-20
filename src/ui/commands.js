/** One catalog for the palette, completion, help, history, and command routing. */
export const COMMANDS = Object.freeze([
    { name: '/help', description: 'Show commands and keyboard shortcuts', kind: 'local' },
    { name: '/status', description: 'Show model, workspace, and session activity', kind: 'local' },
    { name: '/model', description: 'Show the active provider and model', kind: 'local' },
    { name: '/telegram', description: 'Telegram status, connect, disconnect, or reconfigure', kind: 'local', acceptsArgs: true, optionalArgs: true, argument: 'action' },
    { name: '/settings', description: 'Manage optional Telegram settings', kind: 'local', acceptsArgs: true, optionalArgs: true, argument: 'telegram action' },
    { name: '/workspace', description: 'Show the current workspace path', kind: 'local' },
    { name: '/history', description: 'Show recent slash commands', kind: 'local' },
    { name: '/new', description: 'Start a fresh conversation', kind: 'local' },
    { name: '/followups', description: 'Show suggestions for the last response', kind: 'local' },
    { name: '/explain', description: 'Explain a file, function, or concept', kind: 'prompt', acceptsArgs: true, policy: 'read-only', argument: 'file or topic', instruction: 'Explain the following file, function, or concept clearly. Inspect relevant files when a path is provided; list directory contents when needed. Use analysis and examples.' },
    { name: '/review', description: 'Review code for bugs and edge cases', kind: 'prompt', acceptsArgs: true, policy: 'read-only', argument: 'file or task', instruction: 'Review the following code or task for bugs and edge cases. Inspect relevant files; list directory contents when needed. Report findings with file references and explain their impact. Respond with analysis only.' },
    { name: '/fix', description: 'Investigate and fix a bug with approval', kind: 'prompt', acceptsArgs: true, argument: 'bug or file', instruction: 'Investigate and fix the following bug. Read relevant code first; list directory contents when needed. Present file changes through the approval tools and report confirmed results.' },
    { name: '/test', description: 'Inspect coverage or add regression tests', kind: 'prompt', acceptsArgs: true, argument: 'file or behavior', instruction: 'Inspect test coverage for the following code or behavior and add useful regression tests where needed, using file approval tools. Read relevant files first. Clearly distinguish tests inspected or created from tests actually executed with available tools.' },
    { name: '/plan', description: 'Plan an implementation before editing', kind: 'prompt', acceptsArgs: true, policy: 'read-only', argument: 'task', instruction: 'Inspect relevant files and provide a concise step-by-step implementation plan for the following task, including verification. List directory contents when needed. Respond with the plan only.' },
    { name: '/refactor', description: 'Refactor code while preserving behavior', kind: 'prompt', acceptsArgs: true, argument: 'file or goal', instruction: 'Refactor the following code while preserving its behavior. Read relevant files first; list directory contents when needed. Use file approval tools for edits and explain the verified result.' },
    { name: '/summarize', description: 'Summarize code, a topic, or this conversation', kind: 'prompt', acceptsArgs: true, policy: 'read-only', argument: 'file or topic', instruction: 'Summarize the following code, topic, or conversation concisely. Inspect relevant files when needed; list directory contents when needed. Respond with the summary and key facts.' },
    { name: '/continue', description: 'Continue the previous conversation task', kind: 'prompt' },
    { name: '/clear', description: 'Clear the terminal', kind: 'local' },
    { name: '/logout', description: 'Delete saved Puls data and exit after confirmation', kind: 'local' },
    { name: '/bye', description: 'Exit Puls AI', kind: 'local' },
].map((command) => Object.freeze({
    acceptsArgs: false,
    ...command,
    usage: `${command.name}${command.acceptsArgs ? ` <${command.argument}>` : ''}`,
})));

export const COMMAND_NAMES = Object.freeze(COMMANDS.map(({ name }) => name));

export function matchCommands(text = '/') {
    const prefix = String(text).trimStart().toLowerCase();
    if (!prefix.startsWith('/') || /\s/.test(prefix)) return [];
    return COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export function parseCommand(text) {
    const match = /^(\/\S*)(?:\s+([\s\S]*))?$/.exec(String(text).trim());
    if (!match) return null;
    const name = match[1].toLowerCase();
    return { name, args: (match[2] ?? '').trim(), definition: COMMANDS.find((command) => command.name === name) };
}

export function buildCommandPrompt(command, args) {
    if (!command?.instruction || !String(args).trim()) return '';
    return `${command.instruction}\n\nTarget: ${String(args).trim()}`;
}

export function suggestCommandName(name) {
    if (name.length > 32) return undefined;
    const prefix = matchCommands(name)[0];
    if (prefix) return prefix.name;
    const distance = (left, right) => {
        let row = Array.from({ length: right.length + 1 }, (_, index) => index);
        for (let i = 0; i < left.length; i++) {
            const next = [i + 1];
            for (let j = 0; j < right.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (left[i] === right[j] ? 0 : 1)));
            row = next;
        }
        return row.at(-1);
    };
    const nearest = COMMAND_NAMES.map((command) => ({ command, distance: distance(name, command) })).sort((a, b) => a.distance - b.distance)[0];
    return nearest?.distance <= 2 ? nearest.command : undefined;
}

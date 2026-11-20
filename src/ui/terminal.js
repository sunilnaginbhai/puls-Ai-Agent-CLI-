import { sanitizeOutput } from "./sanitize.js";
export { sanitizeOutput, registerSecret } from "./sanitize.js";
import { Chalk } from "chalk";
import { formatError } from "./error-format.js";
import { COMMANDS, COMMAND_NAMES } from './commands.js';
export { COMMANDS } from './commands.js';

export function terminalWidth(output = process.stdout) {
    const columns = Number(output.columns);
    return Number.isFinite(columns) && columns > 0 ? Math.max(8, Math.min(120, Math.floor(columns))) : 80;
}

export function supportsColor(output = process.stdout, env = process.env) {
    return Boolean(output.isTTY) && !("NO_COLOR" in env) && !("NODE_DISABLE_COLORS" in env)
        && env.TERM !== "dumb" && env.FORCE_COLOR !== "0";
}

const singleLine = (value, env) => sanitizeOutput(value, { env }).replace(/\n/g, " ");

// Metadata wraps on grapheme boundaries, including paths without spaces.
function wrap(text, width) {
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    const lines = [];
    let line = "";
    let used = 0;
    for (const { segment } of segments) {
        const wide = /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(segment);
        const cells = wide ? 2 : 1;
        if (used + cells > width && line) {
            lines.push(line);
            line = "";
            used = 0;
        }
        line += segment;
        used += cells;
    }
    if (line || !lines.length) lines.push(line);
    return lines.join("\n");
}

export function createTerminal({ output = process.stdout, error = process.stderr, env = process.env } = {}) {
    const color = new Chalk({ level: supportsColor(output, env) ? 1 : 0 });
    const errorColor = new Chalk({ level: supportsColor(error, env) ? 1 : 0 });
    const emit = (text) => output.write(text);
    const safe = (value) => singleLine(value, env);
    const detail = (label, value) => emit(`${wrap(`${label}  ${safe(value)}`, terminalWidth(output))}\n`);
    return {
        welcome({ model = "Not configured", provider, workspace = process.cwd(), session = "Ready" } = {}) {
            emit(`\n${color.bold.cyan("Puls AI")}${terminalWidth(output) >= 26 ? "  " : "\n"}${color.dim("Coding assistant")}\n\n`);
            detail("Model", provider ? `${model} · ${provider}` : model);
            detail("Workspace", workspace);
            detail("Session", session);
            emit(`\n${color.dim(wrap("/help for commands · /bye to exit", terminalWidth(output)))}\n\n`);
        },
        help() {
            emit(`\n${color.bold("Commands")}\n\n`);
            for (const { usage, description } of COMMANDS) detail(usage, description);
            emit(`\n${color.bold("Keyboard")}\n\n`);
            detail("/", "Open command suggestions; keep typing to filter");
            detail("Up / Down", "Choose a suggestion, or navigate input history");
            detail("Enter / Tab", "Accept / complete a suggestion; Esc closes the menu");
            detail("/1 /2 /3", "Draft a follow-up after a response; Enter sends it");
            detail("Multiline", "End a line with \\ to continue; submit a line without \\");
            detail("Ctrl+C", "Cancel a request or clear input; press again to exit");
            detail("Ctrl+D", "Exit when input is empty");
            emit("\n");
        },
        status({ model = "Not configured", provider, workspace = process.cwd(), turns = 0, status = "Ready", telegram } = {}) {
            emit(`\n${color.bold("Session status")}\n\n`);
            detail("Model", provider ? `${model} · ${provider}` : model);
            detail("Workspace", workspace);
            detail("Agent", status);
            detail("Turns", turns);
            if (telegram) detail('Telegram', telegram);
            emit("\n");
        },
        model({ model, label, provider, timeoutMs } = {}) {
            emit(`\n${color.bold('Active model')}\n\n`);
            detail('Model', model ?? 'Not configured');
            detail('Provider', label ?? provider ?? 'Not configured');
            if (timeoutMs) detail('Request timeout', `${timeoutMs / 1000}s`);
            emit('\n');
        },
        workspace(value) { detail('Workspace', value); },
        history(entries = []) {
            const commands = entries.filter((entry) => COMMAND_NAMES.includes(entry)).slice(0, 15);
            emit(`\n${color.bold('Recent commands')}\n\n`);
            if (commands.length) commands.forEach((entry) => detail(' ', entry));
            else emit('No saved commands yet.\n');
            emit('\n');
        },
        followups(suggestions = []) {
            if (!suggestions.length) {
                emit('Follow-up suggestions appear after an AI response.\n');
                return;
            }
            emit(`\n${color.bold(wrap('Suggested next steps', terminalWidth(output)))}\n`);
            suggestions.slice(0, 3).forEach((suggestion, index) => detail(`/${index + 1}`, suggestion.label));
            emit(`${color.dim(wrap('Choose /1, /2, or /3 to draft a prompt. Review it, then press Enter.', terminalWidth(output)))}\n\n`);
        },
        user(text) {
            emit(`\n${color.bold("You")}\n${sanitizeOutput(text, { env })}\n\n`);
        },
        assistantStart() { emit(`\n${color.bold.cyan("Puls")}\n`); },
        tool({ name, status = "running", details } = {}) {
            const label = { running: "Tool", error: "Failed", cached: "Cached", blocked: "Blocked", stopped: "Stopped", complete: "Done", completed: "Done", success: "Done" }[status] ?? safe(status);
            const summary = [safe(name), details ? safe(details).slice(0, 240) : ""].filter(Boolean).join(" · ");
            emit(`${color.dim(wrap(`${label}  ${summary}`, terminalWidth(output)))}\n`);
        },
        warning(text) { emit(`${color.yellow(`Warning: ${sanitizeOutput(text, { env })}`)}\n`); },
        error(reason) {
            const formatted = formatError(reason);
            error.write(`\n${errorColor.red(formatted.title)}\n${sanitizeOutput(formatted.message, { env })}\n`);
            if (formatted.nextStep) error.write(`${sanitizeOutput(formatted.nextStep, { env })}\n`);
            error.write("\n");
        },
        notice(text) { emit(`${color.dim(sanitizeOutput(text, { env }))}\n`); },
        clear() {
            if (output.isTTY && env.TERM !== "dumb") emit("\u001b[2J\u001b[H");
        },
        write(text) { emit(sanitizeOutput(text, { env })); },
    };
}

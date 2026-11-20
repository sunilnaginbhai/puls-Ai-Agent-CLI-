import { sanitizeOutput } from "./sanitize.js";
export { sanitizeOutput, registerSecret } from "./sanitize.js";
import { Chalk } from "chalk";
import { formatError } from "./error-format.js";

export const COMMANDS = Object.freeze([
    { name: "/help", description: "Show commands and keyboard shortcuts" },
    { name: "/status", description: "Show model, workspace, and session activity" },
    { name: "/clear", description: "Clear the terminal" },
    { name: "/bye", description: "Exit Puls AI" },
]);

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
            for (const { name, description } of COMMANDS) detail(name.padEnd(9), description);
            emit(`\n${color.bold("Keyboard")}\n\n`);
            detail("Tab", "Complete a slash command; Tab again lists matches");
            detail("Up / Down", "Navigate history; cycle command matches after /");
            detail("Multiline", "End a line with \\ to continue; submit a line without \\");
            detail("Ctrl+C", "Cancel a request or clear input; press again to exit");
            detail("Ctrl+D", "Exit when input is empty");
            emit("\n");
        },
        status({ model = "Not configured", provider, workspace = process.cwd(), turns = 0, status = "Ready" } = {}) {
            emit(`\n${color.bold("Session status")}\n\n`);
            detail("Model", provider ? `${model} · ${provider}` : model);
            detail("Workspace", workspace);
            detail("Agent", status);
            detail("Turns", turns);
            emit("\n");
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

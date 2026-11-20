import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { Chalk } from "chalk";
import { stripVTControlCharacters } from "node:util";
import { sanitizeOutput, sensitiveValues } from "./sanitize.js";
import { terminalWidth, supportsColor } from "./terminal.js";

export function contentToMarkdown(content) {
    if (typeof content === "string") return content;

    // LangChain can also return text as content blocks.
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === "string") return block;
                return typeof block?.text === "string" ? block.text : "";
            })
            .filter(Boolean)
            .join("\n");
    }

    return content == null ? "" : JSON.stringify(content, null, 2);
}

export function formatAssistantResponse(content, { width = terminalWidth(), color = supportsColor(), env = process.env } = {}) {
    const palette = new Chalk({ level: color ? 1 : 0 });
    const plain = (text) => text;
    const markdown = sanitizeOutput(contentToMarkdown(content), { env });
    // marked-terminal reflows using UTF-16 offsets and can split a surrogate
    // pair, combining sequence, or ZWJ emoji. Native terminal wrapping preserves
    // those graphemes and accounts for wide characters correctly.
    const nativeWrap = /[\p{Mark}\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\u200d]/u.test(markdown);
    const extension = markedTerminal({
        width: Math.max(8, Math.min(120, width)),
        reflowText: !nativeWrap,
        showSectionPrefix: false,
        emoji: false,
        hyperlinks: false,
        images: false,
        tab: 2,
        firstHeading: palette.bold.cyan,
        heading: palette.bold,
        strong: palette.bold,
        em: color ? palette.italic : plain,
        blockquote: palette.gray,
        code: plain,
        codespan: palette.cyan,
        link: plain,
        href: palette.cyan,
        tableOptions: { style: { head: color ? ["cyan"] : [], border: [] } },
    });
    const renderCode = extension.renderer.code;
    extension.renderer.code = function (token) {
        const language = sanitizeOutput(token.lang ?? "text", { env }).split(/\s+/)[0] || "text";
        return `\n${palette.dim(language)}\n${renderCode.call(this, token).trimEnd()}\n\n`;
    };
    const parser = new Marked(extension);
    const rendered = String(parser.parse(markdown)).trimEnd();
    return color ? rendered : stripVTControlCharacters(rendered);
}

// Flush complete Markdown blocks progressively. A fence is held until it closes,
// so syntax highlighting and code indentation remain stable during streaming.
export function createResponseStream({ write = (text) => process.stdout.write(text), width, color, env } = {}) {
    let pending = "";
    let ended = false;
    let plainParagraph = false;
    function flush(text, complete = true) {
        if (!text.trim()) return;
        if (plainParagraph) {
            write(sanitizeOutput(text, { env }));
            if (complete && !text.endsWith("\n\n")) write("\n\n");
        } else write(`${formatAssistantResponse(text, { width: typeof width === "function" ? width() : width, color, env })}\n\n`);
    }
    function drain(final = false) {
        // A private key can contain blank lines. Keep the whole block together
        // so redaction never prints a later fragment without its BEGIN marker.
        if (!final && /-----BEGIN [^-]*PRIVATE KEY-----/.test(pending) && !/-----END [^-]*PRIVATE KEY-----/.test(pending)) return;
        pending = pending.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]");
        let fence;
        while (pending) {
            let boundary = 0;
            let offset = 0;
            fence = undefined;
            for (const line of pending.split(/(?<=\n)/)) {
                const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
                if (marker) {
                    if (!fence) fence = { character: marker[1][0], length: marker[1].length };
                    else if (marker[1][0] === fence.character && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
                }
                offset += line.length;
                if (!fence && /\n$/.test(line) && (!line.trim() || marker)) {
                    boundary = offset;
                    break;
                }
            }
            if (!boundary) break;
            flush(pending.slice(0, boundary));
            pending = pending.slice(boundary);
            plainParagraph = false;
        }
        if (final) {
            flush(pending);
            pending = "";
            return;
        }
        // Long prose is displayed progressively without reprinting or moving
        // the cursor. Keep 256 characters and flush only at whitespace, never
        // through a credential token split between provider chunks.
        const secrets = sensitiveValues(env ?? process.env);
        const retain = Math.max(256, ...secrets.map((secret) => secret.length));
        if (!fence && pending.length > retain + 256) {
            let cutoff = pending.lastIndexOf(" ", pending.length - retain);
            const assignment = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*["']?\s*$/i.exec(pending.slice(0, cutoff));
            if (assignment) cutoff = assignment.index - 1;
            for (const secret of secrets) {
                const start = pending.indexOf(secret);
                if (start >= 0 && start < cutoff && start + secret.length > cutoff) cutoff = start - 1;
            }
            if (cutoff > 0) {
                plainParagraph = true;
                flush(pending.slice(0, cutoff + 1), false);
                pending = pending.slice(cutoff + 1);
            }
        }
    }
    return {
        push(text) {
            if (ended) return;
            pending += String(text ?? "");
            drain();
        },
        end() {
            if (ended) return;
            drain(true);
            ended = true;
        },
        cancel() {
            if (ended) return;
            drain(true);
            ended = true;
        },
    };
}

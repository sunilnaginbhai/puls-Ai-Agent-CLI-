import { stripVTControlCharacters } from "node:util";

const registeredSecrets = new Set();

export function registerSecret(value) {
    if (typeof value !== "string" || value.length < 4) return () => {};
    registeredSecrets.add(value);
    return () => registeredSecrets.delete(value);
}

export function sensitiveValues(env = process.env) {
    return [...registeredSecrets, ...Object.entries(env)
        .filter(([name, value]) => /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && typeof value === "string" && value.length >= 8)
        .map(([, value]) => value)];
}

// Treat all provider, workspace, and tool text as untrusted terminal input.
// OSC/CSI sequences can otherwise change the clipboard, title, or cursor.
export function sanitizeOutput(value, { env = process.env } = {}) {
    let text = stripVTControlCharacters(String(value ?? ""))
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
        .replace(/\b(?:gsk_|sk-(?:proj-|svcacct-)?)[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
        .replace(/\bAIza[a-zA-Z0-9_-]{20,}\b/g, "[redacted]")
        .replace(/\bBearer\s+[^\s,;"'}]+/gi, "Bearer [redacted]")
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s,"';}\]]+)/gi, "$1[redacted]");
    for (const secret of sensitiveValues(env)) {
        text = text.replaceAll(secret, "[redacted]");
    }
    return text;
}


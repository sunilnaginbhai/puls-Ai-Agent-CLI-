import test from "node:test";
import assert from "node:assert/strict";
import { createTerminal, sanitizeOutput, terminalWidth, registerSecret } from "../../src/ui/terminal.js";
import { formatError } from "../../src/ui/error-format.js";
import { formatAssistantResponse, createResponseStream } from "../../src/ui/markdown.js";

function outputStream(columns = 80, isTTY = false) {
    let text = "";
    return { columns, isTTY, write(chunk) { text += chunk; }, get text() { return text; } };
}

test("terminal sanitization removes control sequences and redacts provider credentials", () => {
    const result = sanitizeOutput("\u001b[2Jhello\u001b]52;c;YXR0YWNr\u0007\u0000\r\n" +
        "Bearer arbitrary-token apiKey: custom-password gsk_123456789abcdef sk-proj-123456789abcdef abc12345", {
        env: { SERVICE_TOKEN: "abc12345" },
    });
    assert.match(result, /^hello\n/);
    assert.doesNotMatch(result, /\u001b|\u0000|arbitrary-token|custom-password|123456789abcdef|abc12345/);
    assert.match(result, /\[redacted\]/);
});

test("saved keys with arbitrary provider formats can be registered for output redaction", () => {
    const cleanup = registerSecret("arbitrary-format-saved-provider-key");
    try {
        assert.equal(sanitizeOutput("Failure: arbitrary-format-saved-provider-key", { env: {} }), "Failure: [redacted]");
    } finally { cleanup(); }
});

test("terminal displays current metadata and honors NO_COLOR even with FORCE_COLOR", () => {
    const output = outputStream(34, true);
    const terminal = createTerminal({ output, error: output, env: { NO_COLOR: "", FORCE_COLOR: "1" } });
    terminal.welcome({ model: "test-model", provider: "test", workspace: "C:\\Workspace\\a-very-long-project-directory", session: "Ready" });
    terminal.status({ model: "other-model", workspace: "/project", turns: 3 });
    terminal.tool({ name: "readFile", details: "src/app.js" });
    assert.doesNotMatch(output.text, /\u001b/);
    assert.match(output.text, /test-model/);
    assert.match(output.text, /other-model/);
    assert.match(output.text, /Turns\s+3/);
    assert.match(output.text, /readFile/);
    for (const line of output.text.split("\n").filter((line) => line.startsWith("Workspace") || line.includes("directory"))) {
        assert.ok(line.length <= 34);
    }
});

test("clear does not emit cursor controls into a pipe or dumb terminal", () => {
    for (const [isTTY, env] of [[false, {}], [true, { TERM: "dumb" }]]) {
        const output = outputStream(80, isTTY);
        createTerminal({ output, env }).clear();
        assert.equal(output.text, "");
    }
});

test("metadata adapts to terminal resizing without splitting emoji graphemes", () => {
    const output = outputStream(60);
    const terminal = createTerminal({ output, env: {} });
    output.columns = 16;
    terminal.status({ model: "model", workspace: "/项目/👩‍💻/abcdefghijk", turns: 0 });
    assert.equal(terminalWidth(output), 16);
    assert.ok(output.text.includes("👩‍💻"));
    assert.doesNotMatch(output.text, /\ud83d\n|\udc69\n/);
});

test("Markdown renders content blocks, labelled code and tables without ANSI in no-color mode", () => {
    const rendered = formatAssistantResponse([
        { type: "text", text: "# Heading\n\n- first\n- second\n\n```js\nconst value = 1;\n```\n\n| File | State |\n| --- | --- |\n| app.js | ready |" },
        { type: "image_url", image_url: "ignored" },
    ], { width: 40, color: false });
    assert.match(rendered, /Heading/);
    assert.match(rendered, /first/);
    assert.match(rendered, /js\n\s+const value = 1;/);
    assert.match(rendered, /app.js/);
    assert.doesNotMatch(rendered, /\u001b|ignored/);
});

test("narrow Markdown rendering preserves surrogate pairs and joined Unicode graphemes", () => {
    for (const text of ["😀".repeat(20), "👩‍💻".repeat(20), "e\u0301".repeat(20), "中文".repeat(20)]) {
        const rendered = formatAssistantResponse(text, { width: 17, color: false });
        assert.equal(rendered.replaceAll("\n", ""), text);
        assert.equal(rendered.isWellFormed(), true);
        assert.ok(rendered.includes(text));
    }
});

test("stream renderer emits completed paragraphs once and buffers split code fences", () => {
    let result = "";
    const stream = createResponseStream({ write: (text) => { result += text; }, color: false });
    stream.push("First **answer**.\n\n");
    assert.match(result, /First answer/);
    stream.push("```j");
    stream.push("s\nconst value = 1;\n");
    assert.doesNotMatch(result, /value/);
    stream.push("```\n\nSecond answer.");
    assert.match(result, /const value = 1;/);
    assert.doesNotMatch(result, /Second answer/);
    stream.end();
    stream.end();
    assert.match(result, /Second answer/);
    assert.equal(result.match(/First answer/g).length, 1);
    assert.equal(result.match(/const value = 1;/g).length, 1);
});

test("stream renderer redacts a credential split between incoming chunks", () => {
    let result = "";
    const stream = createResponseStream({ write: (text) => { result += text; }, color: false });
    stream.push("Secret: gsk_1234");
    stream.push("56789abcdef\n\n");
    stream.end();
    assert.doesNotMatch(result, /gsk_|123456789abcdef/);
    assert.match(result, /redacted/);
});

test("long paragraphs stream before completion without replaying text", () => {
    let result = "";
    const stream = createResponseStream({ write: (text) => { result += text; }, color: false });
    const paragraph = "A useful explanation with words. ".repeat(30);
    stream.push(paragraph);
    assert.ok(result.length > 0);
    assert.ok(result.length < paragraph.length);
    stream.push("Final sentence.");
    stream.end();
    assert.equal(result.trimEnd(), `${paragraph}Final sentence.`);
});

test("progressive prose keeps long saved secrets and split terminal escapes safe", () => {
    let result = "";
    const secret = `private prefix ${"sensitive ".repeat(60)}private suffix`;
    const cleanup = registerSecret(secret);
    const stream = createResponseStream({ write: (text) => { result += text; }, color: false, env: {} });
    try {
        stream.push("Ordinary explanation. ".repeat(80) + secret.slice(0, 450));
        stream.push(secret.slice(450) + " Safe ending.\u001b]52;c;");
        stream.push("YXR0YWNr\u0007\n\n");
        stream.end();
        assert.match(result, /redacted/);
        assert.doesNotMatch(result, /private prefix|private suffix|sensitive|\u001b|\u0007/);
    } finally { cleanup(); }
});

test("stream redacts a private key even when its paragraphs arrive separately", () => {
    let result = "";
    const stream = createResponseStream({ write: (text) => { result += text; }, color: false });
    stream.push("-----BEGIN PRIVATE KEY-----\n\nfirstsecretpart\n\n");
    assert.equal(result, "");
    stream.push("secondsecretpart\n-----END PRIVATE KEY-----\n\n");
    stream.end();
    assert.match(result, /redacted private key/);
    assert.doesNotMatch(result, /firstsecretpart|secondsecretpart/);
});

test("unknown errors and debug text cannot reveal keys or terminal controls", () => {
    const result = formatError(new Error("bad \u001b[31mresponse api_key=example-private-key"));
    assert.match(result.message, /redacted/);
    assert.doesNotMatch(result.message, /example-private-key|\u001b/);
    assert.equal(formatError({ name: "AbortError" }).title, "Request cancelled");
    assert.equal(formatError({ code: "EPERM" }).title, "Filesystem permission denied");
});

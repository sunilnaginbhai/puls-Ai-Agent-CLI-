import test from "node:test";
import assert from "node:assert/strict";
import { formatError } from "../../src/ui/error-format.js";

test("formats provider rate limits with a safe retry instruction", () => {
    const result = formatError({
        status: 429,
        message: "429 rate_limit_exceeded",
    });

    assert.equal(result.title, "Rate limit reached");
    assert.match(result.nextStep, /check whether a file tool already completed/i);
});

test("distinguishes invalid credentials from access denial", () => {
    assert.equal(formatError({ status: 401 }).title, "Authentication failed");
    assert.equal(formatError({ status: 403 }).title, "Access denied");
});

test("turns connection refused into an actionable message", () => {
    const result = formatError({ code: "ECONNREFUSED" });

    assert.equal(result.title, "Connection refused");
    assert.match(result.nextStep, /service is running/i);
});

test("preserves a useful fallback for unknown errors", () => {
    const result = formatError(new Error("unexpected test failure"));

    assert.equal(result.title, "Request failed");
    assert.equal(result.message, "unexpected test failure");
    assert.match(result.nextStep, /\$env:PULS_AI_DEBUG = '1'/);
});

test("explains invalid tool calls without claiming a file change", () => {
    const result = formatError(new Error("Tool choice is none, but model called a tool"));

    assert.equal(result.title, "Tool call unavailable");
    assert.match(result.message, /No file operation ran/i);
    assert.match(result.nextStep, /PULS_AI_WORKSPACE/i);

    const malformed = formatError(new Error("Failed to parse tool call arguments as JSON"));
    assert.equal(malformed.title, "Tool call unavailable");
});

test('explains agent loop and input limits with actionable recovery', () => {
    const recursion = formatError({ name: 'GraphRecursionError', message: 'Recursion limit reached without a stop condition.' });
    assert.equal(recursion.title, 'Agent step limit reached');
    assert.match(recursion.nextStep, /smaller task/);
    const input = formatError({ code: 'ERR_INPUT_LIMIT', message: 'Queue overflow' });
    assert.equal(input.title, 'Input limit reached');
    assert.match(input.nextStep, /smaller batches/);
});

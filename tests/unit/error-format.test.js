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
});

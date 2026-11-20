import test from "node:test";
import assert from "node:assert/strict";
import { AIMessageChunk } from "@langchain/core/messages";
import { LLMNode } from "../../src/agent/model.node.js";

const providerConfig = { provider: "groq", model: "test-model", timeoutMs: 1000 };
const messages = [{ role: "user", content: "What is a closure?" }];

test("streams text progressively and preserves the accumulated assistant message", async () => {
    const output = [];
    const callbacks = { tag: "propagated callback" };
    const model = {
        async *stream(input, options) {
            assert.equal(input, messages);
            assert.equal(options.callbacks, callbacks);
            assert.ok(options.signal instanceof AbortSignal);
            yield new AIMessageChunk({ content: "Hello " });
            assert.deepEqual(output, ["Hello "]);
            yield new AIMessageChunk({ content: [{ type: "text", text: "world" }] });
        },
    };
    const result = await LLMNode({ messages }, {
        callbacks,
        configurable: {
            apiKey: "test-key", providerConfig,
            modelFactory: async (options) => {
                assert.equal(options.config.model, "test-model");
                assert.equal(options.maxTokens, 1024);
                return model;
            },
            onToken: (text) => output.push(text),
        },
    });
    assert.deepEqual(output, ["Hello ", "world"]);
    assert.ok(result.messages[0]);
});

test("passes cancellation through and stops before consuming further chunks", async () => {
    const controller = new AbortController();
    const output = [];
    const result = LLMNode({ messages }, {
        signal: controller.signal,
        configurable: {
            apiKey: "test-key", providerConfig,
            modelFactory: async () => ({
                async *stream(_input, options) {
                    yield new AIMessageChunk({ content: "partial" });
                    controller.abort(new DOMException("Cancelled", "AbortError"));
                    assert.equal(options.signal.aborted, true);
                    yield new AIMessageChunk({ content: "must not print" });
                },
            }),
            onToken: (text) => output.push(text),
        },
    });
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(output, ["partial"]);
});

test("times out an interrupted provider stream with an actionable timeout error", async () => {
    await assert.rejects(LLMNode({ messages }, {
        configurable: {
            apiKey: "test-key", providerConfig: { ...providerConfig, timeoutMs: 5 },
            modelFactory: async () => ({
                async *stream(_input, options) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    options.signal.throwIfAborted();
                    yield new AIMessageChunk({ content: "late" });
                },
            }),
        },
    }), (error) => error.code === "ETIMEDOUT" && /PULS_REQUEST_TIMEOUT_MS/.test(error.message));
});

test("rejects empty streams but preserves valid tool-only responses", async () => {
    const configurable = { apiKey: "test-key", providerConfig, modelFactory: async () => ({ async *stream() {} }) };
    await assert.rejects(LLMNode({ messages }, { configurable }), /empty response stream/);
    configurable.modelFactory = async () => ({
        async *stream() {
            yield new AIMessageChunk({
                content: "",
                tool_call_chunks: [{ name: "readFile", args: '{"path":"README.md"}', id: "call-1", index: 0 }],
            });
        },
    });
    const result = await LLMNode({ messages }, { configurable });
    assert.equal(result.messages[0].tool_calls[0].name, "readFile");
});

test("file mutations bind only selected tools without parallel execution", async () => {
    let boundTools;
    let boundOptions;
    let maximum;
    await LLMNode({ messages: [{ role: "user", content: "Update the code in src/main.js" }] }, {
        configurable: {
            apiKey: "test-key", providerConfig,
            modelFactory: async ({ maxTokens }) => {
                maximum = maxTokens;
                return {
                    bindTools(tools, options) {
                        boundTools = tools.map((tool) => tool.name);
                        boundOptions = options;
                        return { async *stream() { yield new AIMessageChunk({ content: "Ready" }); } };
                    },
                };
            },
        },
    });
    assert.deepEqual(boundTools, ["readFile", "applyFileOperations"]);
    assert.deepEqual(boundOptions, { parallel_tool_calls: false });
    assert.equal(maximum, 4096);
});

test('pre-cancelled requests never resolve a key or initialize a model', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    let created = false;
    await assert.rejects(LLMNode({ messages }, {
        signal: controller.signal,
        configurable: { providerConfig, modelFactory: async () => { created = true; throw new Error('Must not initialize'); } },
    }), { name: 'AbortError' });
    assert.equal(created, false);
});

test('request deadlines cover asynchronous model initialization', async () => {
    let streamed = false;
    await assert.rejects(LLMNode({ messages }, {
        configurable: {
            apiKey: 'test-key', providerConfig: { ...providerConfig, timeoutMs: 5 },
            modelFactory: async () => {
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { async *stream() { streamed = true; yield new AIMessageChunk({ content: 'late' }); } };
            },
        },
    }), (error) => error.code === 'ETIMEDOUT');
    assert.equal(streamed, false);
});

test('text cannot hide invalid tool arguments in a completed response', async () => {
    await assert.rejects(LLMNode({ messages }, {
        configurable: {
            apiKey: 'test-key', providerConfig,
            modelFactory: async () => ({ async *stream() {
                yield new AIMessageChunk({ content: 'Reading now.', tool_call_chunks: [{ name: 'readFile', args: 'not-json', id: 'call-bad', index: 0 }] });
            } }),
        },
    }), /invalid tool arguments/);
});

test('output-limited tool responses never reach execution even when JSON is complete', async () => {
    await assert.rejects(LLMNode({ messages }, {
        configurable: {
            apiKey: 'test-key', providerConfig,
            modelFactory: async () => ({ async *stream() {
                yield new AIMessageChunk({ content: '', response_metadata: { finish_reason: 'length' }, tool_call_chunks: [{ name: 'readFile', args: '{"path":"README.md"}', id: 'call-limited', index: 0 }] });
            } }),
        },
    }), (error) => error.code === 'MODEL_OUTPUT_TRUNCATED');
});

test('read-only commands never bind mutation tools even when the task mentions fixes', async () => {
    let boundTools;
    await LLMNode({ messages: [{ role: 'user', content: 'Review and fix bugs in src/main.js' }] }, {
        configurable: {
            apiKey: 'test-key', providerConfig, toolPolicy: 'read-only',
            modelFactory: async () => ({ bindTools(tools) {
                boundTools = tools.map((tool) => tool.name);
                return { async *stream() { yield new AIMessageChunk({ content: 'Review findings.' }); } };
            } }),
        },
    });
    assert.deepEqual(boundTools, ['readFile']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ChatOpenAI } from '@langchain/openai';
import { LLMNode } from '../../src/agent/model.node.js';
import { formatError } from '../../src/ui/error-format.js';

// This file never resolves credentials or contacts a model service. The real
// SDK is pointed explicitly at loopback and receives only this dummy key.
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';
const dummyKey = 'offline-loopback-dummy-key';
const providerConfig = { provider: 'openai', model: 'offline-chat', timeoutMs: 3000 };
const messages = [{ role: 'user', content: 'What is a closure?' }];
const event = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-loopback', object: 'chat.completion.chunk', created: 0, model: 'offline-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const begin = (response) => response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
const finish = (response, reason = 'stop') => { response.write(event({}, reason)); response.end('data: [DONE]\n\n'); };

async function localProvider(t, handler) {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        let raw = '';
        try {
            for await (const chunk of request) raw += chunk;
            requests.push({ path: request.url, body: JSON.parse(raw) });
            await handler(request, response);
        } catch { response.destroy(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    return {
        requests,
        modelFactory: () => new ChatOpenAI({
            model: 'offline-chat', apiKey: dummyKey, maxRetries: 0, timeout: 3000,
            streamUsage: false, configuration: { baseURL, organization: 'offline', project: 'offline' },
        }),
    };
}

function options(server, additions = {}) {
    return { configurable: { providerConfig, apiKey: dummyKey, modelFactory: server.modelFactory, ...additions } };
}

test('real provider SDK streams SSE text progressively over loopback HTTP', { timeout: 10000 }, async (t) => {
    let receivedFirst;
    const firstToken = new Promise((resolve) => { receivedFirst = resolve; });
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', content: 'Hello ' }));
        await firstToken;
        response.write(event({ content: 'world' }));
        finish(response);
    });
    const tokens = [];
    const response = await LLMNode({ messages }, options(server, { onToken: (text) => { tokens.push(text); receivedFirst(); } }));
    assert.deepEqual(tokens, ['Hello ', 'world']);
    assert.equal(response.messages[0].content, 'Hello world');
    assert.equal(server.requests[0].path, '/v1/chat/completions');
    assert.equal(server.requests[0].body.stream, true);
    assert.equal(server.requests.length, 1);
});

test('real provider SDK joins split tool arguments before execution', { timeout: 10000 }, async (t) => {
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-local', type: 'function', function: { name: 'readFile', arguments: '{"path":' } }] }));
        response.write(event({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }));
        finish(response, 'tool_calls');
    });
    const response = await LLMNode({ messages: [{ role: 'user', content: 'Read README.md' }] }, options(server));
    assert.equal(response.messages[0].tool_calls[0].name, 'readFile');
    assert.deepEqual(response.messages[0].tool_calls[0].args, { path: 'README.md' });
    assert.equal(server.requests[0].body.tools[0].function.name, 'readFile');
});

test('truncated SSE tool JSON is rejected even when partial parsing produced arguments', { timeout: 10000 }, async (t) => {
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-local', type: 'function', function: { name: 'readFile', arguments: '{"path":"README.md"' } }] }));
        finish(response, 'tool_calls');
    });
    await assert.rejects(LLMNode({ messages: [{ role: 'user', content: 'Read README.md' }] }, options(server)), /incomplete or invalid tool arguments/);
});

test('real SDK rate-limit failures remain actionable without replaying a request', { timeout: 10000 }, async (t) => {
    const server = await localProvider(t, async (_request, response) => {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Rate limit reached api_key=sk-offline-secret-value', type: 'rate_limit_error' } }));
    });
    await assert.rejects(LLMNode({ messages }, options(server)), (error) => {
        const formatted = formatError(error);
        assert.equal(formatted.title, 'Rate limit reached');
        assert.doesNotMatch(JSON.stringify(formatted), /sk-offline-secret-value/);
        return true;
    });
    assert.equal(server.requests.length, 1);
});

test('cancelling a real SDK response stops a stalled SSE connection', { timeout: 10000 }, async (t) => {
    const controller = new AbortController();
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', content: 'partial' }));
        // Remain open: only cancellation should unblock the consumer.
    });
    const tokens = [];
    await assert.rejects(LLMNode({ messages }, {
        ...options(server, { onToken: (text) => { tokens.push(text); controller.abort(new DOMException('Cancelled', 'AbortError')); } }),
        signal: controller.signal,
    }), { name: 'AbortError' });
    assert.deepEqual(tokens, ['partial']);
});

test('the request deadline stops real SDK SSE consumption after partial output', { timeout: 10000 }, async (t) => {
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', content: 'partial' }));
    });
    await assert.rejects(LLMNode({ messages }, options(server, { providerConfig: { ...providerConfig, timeoutMs: 200 } })), (error) => error.code === 'ETIMEDOUT');
    assert.equal(server.requests.length, 1);
});

test('a broken real SDK SSE transport rejects after retaining already streamed text', { timeout: 10000 }, async (t) => {
    const server = await localProvider(t, async (_request, response) => {
        begin(response);
        response.write(event({ role: 'assistant', content: 'partial' }));
        const timer = setTimeout(() => response.destroy(), 20);
        response.once('close', () => clearTimeout(timer));
    });
    const tokens = [];
    await assert.rejects(LLMNode({ messages }, options(server, { onToken: (text) => tokens.push(text) })));
    assert.deepEqual(tokens, ['partial']);
    assert.equal(server.requests.length, 1);
});

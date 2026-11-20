import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgentGraph } from '../../src/agent/agent.graph.js';
import { createExecutionState } from '../../src/agent/tools.node.js';
import { trimConversation, recoverConversation, FAILURE_NOTE } from '../../src/agent/conversation.js';

const call = (name, id, args = { path: 'file.js' }) => new AIMessage({ content: '', tool_calls: [{ name, id, args, type: 'tool_call' }] });

test('real LangGraph execution reuses duplicate tool results without repeating side effects', async () => {
    let count = 0;
    let turns = 0;
    const inspect = tool(async () => { count++; return 'confirmed'; }, { name: 'inspect', schema: z.object({ path: z.string() }) });
    const graph = createAgentGraph({
        tools: [inspect],
        modelNode: async () => ({ messages: [++turns < 3 ? call('inspect', `id-${turns}`) : new AIMessage('done')] }),
    });
    const response = await graph.invoke({ messages: [new HumanMessage('inspect file')] }, { configurable: { execution: createExecutionState() } });
    assert.equal(count, 1);
    assert.equal(response.messages.filter((message) => message.getType() === 'tool').length, 2);
    assert.equal(response.messages.at(-1).content, 'done');
});

test('a denied mutation cannot be retried with different arguments in the same turn', async () => {
    let count = 0;
    let turns = 0;
    const mutate = tool(async () => { count++; return 'Cancelled. None executed.'; }, { name: 'applyFileOperations', schema: z.object({ path: z.string() }) });
    const graph = createAgentGraph({
        tools: [mutate], modelNode: async () => ({ messages: [++turns < 3 ? call('applyFileOperations', `id-${turns}`, { path: `${turns}.js` }) : new AIMessage('declined')] }),
    });
    const response = await graph.invoke({ messages: [new HumanMessage('write file')] }, { configurable: { execution: createExecutionState() } });
    assert.equal(count, 1);
    assert.match(response.messages.at(-2).content, /Stopped repeated tool execution/);
});

test('context trimming retains complete tool exchanges and latest request', () => {
    const messages = [new SystemMessage('system'), new HumanMessage('a'.repeat(100)), new AIMessage('old'), new HumanMessage('new'), call('inspect', 'tool-1')];
    const repaired = recoverConversation(messages);
    const trimmed = trimConversation(repaired, { maxChars: 350 });
    assert.equal(trimmed[0].content, 'system');
    assert.ok(trimmed.some((message) => message.content === 'new'));
    assert.ok(trimmed.some((message) => message.tool_call_id === 'tool-1'));
    assert.equal(trimmed.at(1).content, FAILURE_NOTE);
    assert.ok(!trimmed.some((message) => message.content === 'a'.repeat(100)));
});

test('failure recovery retains confirmed results from an interrupted tool batch', () => {
    const messages = [new HumanMessage('inspect'), call('inspect', 'tool-1')];
    const recovered = recoverConversation(messages, [{ type: 'tool', tool_call_id: 'tool-1', content: 'confirmed result' }]);
    assert.equal(recovered.at(-2).content, 'confirmed result');
    assert.equal(recovered.at(-1).content, FAILURE_NOTE);
});

test('failure recovery puts missing tool results before the next user turn', () => {
    const confirmed = new ToolMessage({ content: 'read completed', name: 'inspect', tool_call_id: 'read-1' });
    const messages = [
        new HumanMessage('inspect'), call('inspect', 'read-1'), confirmed,
        call('inspect', 'read-2'), new HumanMessage('continue'),
    ];
    const result = recoverConversation(messages);
    const request = result.findIndex((message) => message.tool_calls?.[0]?.id === 'read-2');
    assert.equal(result[request + 1].tool_call_id, 'read-2');
    assert.equal(result[request + 2].content, 'continue');
    assert.equal(result.filter((message) => message.tool_call_id === 'read-1').length, 1);
    assert.equal(result.find((message) => message.tool_call_id === 'read-1'), confirmed);
});

test('reused provider tool IDs cannot replace interrupted work with an older success', () => {
    const old = new ToolMessage({ content: 'Old batch completed.', tool_call_id: 'reused-id', name: 'applyFileOperations', status: 'success' });
    const current = new ToolMessage({ content: 'Current batch interrupted.', tool_call_id: 'reused-id', name: 'applyFileOperations', status: 'error' });
    const result = recoverConversation([
        new HumanMessage('old task'), call('applyFileOperations', 'reused-id'), old,
        new HumanMessage('current task'), call('applyFileOperations', 'reused-id'),
    ], [current], { fileOperations: [{ type: 'write_file', path: '/workspace/current.js', tool_call_id: 'reused-id', status: 'complete' }] });
    const tools = result.filter((message) => message.getType?.() === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0], old);
    assert.doesNotMatch(tools[0].content, /current\.js/);
    assert.equal(tools[1].status, 'error');
    assert.match(tools[1].content, /Current batch interrupted/);
    assert.match(tools[1].content, /current\.js/);
    assert.doesNotMatch(tools[1].content, /Old batch completed/);
});

import { prepareModelMessages } from '../../src/agent/conversation.js';
import { ToolMessage } from '@langchain/core/messages';

test('oversized tool output is bounded for the model without altering history', () => {
    const original = new ToolMessage({ content: 'x'.repeat(30000), name: 'inspect', tool_call_id: 'tool-1' });
    const messages = [new HumanMessage('inspect'), call('inspect', 'tool-1'), original];
    const bounded = prepareModelMessages(messages);
    assert.ok(bounded.at(-1).content.length < 12500);
    assert.equal(original.content.length, 30000);
    assert.equal(bounded.at(-1).tool_call_id, 'tool-1');
    assert.throws(() => prepareModelMessages(messages, { maxChars: 20 }), /context is too large/);
});

test('reads after a mutation observe fresh content instead of a cached earlier result', async () => {
    let text = 'before';
    let turn = 0;
    let reads = 0;
    const read = tool(async () => { reads++; return text; }, { name: 'inspect', schema: z.object({ path: z.string() }) });
    const write = tool(async () => { text = 'after'; return 'Updated'; }, { name: 'applyFileOperations', schema: z.object({ path: z.string() }) });
    const graph = createAgentGraph({ tools: [read, write], modelNode: async () => {
        turn++;
        return { messages: [turn === 1 ? call('inspect', 'read-1') : turn === 2 ? call('applyFileOperations', 'write-1') : turn === 3 ? call('inspect', 'read-2') : new AIMessage('done')] };
    } });
    const result = await graph.invoke({ messages: [new HumanMessage('update file')] }, { configurable: { execution: createExecutionState() } });
    assert.equal(reads, 2);
    assert.equal(result.messages.find((message) => message.tool_call_id === 'read-2').content, 'after');
});

import initializeSession from '../../src/agent/session.js';
import { EventEmitter } from 'node:events';
import { createTerminal } from '../../src/ui/terminal.js';

test('cancelling a streamed session preserves failure context and removes listeners', async () => {
    const input = new EventEmitter();
    input.isInteractive = true;
    const requests = ['hello', '/bye'];
    input.readInput = async () => requests.shift();
    let displayed = '';
    const output = { write(text) { displayed += text; }, columns: 80, isTTY: false };
    const graph = createAgentGraph({ tools: [], modelNode: async (state, config) => {
        await config.configurable.onToken('Response started.\n\n');
        input.emit('cancel');
        config.signal.throwIfAborted();
        return { messages: [new AIMessage('unreachable')] };
    } });
    const result = await initializeSession({ input, output, graph, terminal: createTerminal({ output, error: output }), providerConfig: { model: 'test' } });
    assert.match(displayed, /Response started/);
    assert.match(displayed, /Request cancelled/);
    assert.match(displayed, /Goodbye/);
    assert.equal(result.turns, 0);
    assert.equal(result.messages.at(-1).content, FAILURE_NOTE);
    assert.equal(input.listenerCount('cancel'), 0);
    assert.equal(input.listenerCount('close'), 0);
});

test('interrupted mutation progress remains visible and is retained in tool history', async () => {
    const input = new EventEmitter();
    input.isInteractive = true;
    const requests = ['write two files', '/bye'];
    input.readInput = async () => requests.shift();
    let displayed = '';
    const output = { write(text) { displayed += text; }, columns: 80, isTTY: false };
    const mutate = tool(async (args, config) => {
        await config.configurable.onFileOperation({ type: 'write_file', path: '/workspace/first.js', mode: 'create', status: 'complete' });
        input.emit('cancel');
        config.signal.throwIfAborted();
        return 'unreachable';
    }, { name: 'applyFileOperations', schema: z.object({ path: z.string() }) });
    const graph = createAgentGraph({ tools: [mutate], modelNode: async () => ({ messages: [call('applyFileOperations', 'mutation-1')] }) });
    const result = await initializeSession({ input, output, graph, terminal: createTerminal({ output, error: output }), providerConfig: { model: 'test' } });
    assert.match(displayed, /Created file.*first\.js/);
    assert.match(displayed, /Request cancelled/);
    const recovered = result.messages.find((message) => message.tool_call_id === 'mutation-1');
    assert.ok(recovered);
    assert.match(recovered.content, /Confirmed completed file operations/);
    assert.match(recovered.content, /first\.js/);
    assert.match(recovered.content, /remaining operations are unconfirmed/);
});

test('the tool executor blocks mutation attempts made during a read-only command', async () => {
    let changes = 0;
    let requests = 0;
    const mutate = tool(async () => { changes++; return 'must not execute'; }, { name: 'applyFileOperations', schema: z.object({ path: z.string() }) });
    const graph = createAgentGraph({ tools: [mutate], modelNode: async () => ({ messages: [++requests === 1 ? call('applyFileOperations', 'blocked-1') : new AIMessage('Analysis complete.')] }) });
    const result = await graph.invoke({ messages: [new HumanMessage('Review file')] }, { configurable: { execution: createExecutionState(), toolPolicy: 'read-only' } });
    assert.equal(changes, 0);
    assert.match(result.messages.find((message) => message.tool_call_id === 'blocked-1').content, /read-only/);
});

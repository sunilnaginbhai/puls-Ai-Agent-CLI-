import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { TelegramClient, TelegramError } from '../../src/integrations/telegram/client.js';
import { TelegramRuntime } from '../../src/integrations/telegram/runtime.js';
import { TelegramIntegration, parseUserIds } from '../../src/integrations/telegram/integration.js';
import { TokenVault } from '../../src/integrations/telegram/vault.js';
import { createAgentGraph } from '../../src/agent/agent.graph.js';

const token = '123456:dummy_token_for_local_tests_only';
function harness(answers = []) {
    let settings = {}, written = '', calls = [], starts = 0, stops = 0;
    const input = { isInteractive: true, question: async () => answers.shift() };
    const integration = new TelegramIntegration({ input, output: { write(t) { written += t; } }, providerConfig: { model: 'test' },
        readSettings: async () => settings, saveSettings: async (update) => { settings = update(settings); },
        vault: { seal: async () => ({ type: 'test-encrypted', value: 'ciphertext' }), open: async () => token },
        clientFactory: () => ({ call: async (method) => { calls.push(method); return method === 'getMe' ? { is_bot: true, username: 'local_bot' } : method === 'getWebhookInfo' ? { url: '' } : []; } }),
        runtimeFactory: () => ({ status: 'Connected', start() { starts++; }, async stop() { stops++; } }),
    });
    return { integration, input, state: () => ({ settings, written, calls, starts, stops }) };
}

test('Telegram is fully optional: Skip saves preference without token prompt or network', async () => {
    const h = harness(['skip']);
    await h.integration.onboard();
    await h.integration.start();
    assert.deepEqual(h.state().calls, []);
    assert.equal(h.state().settings.telegram.enabled, false);
    assert.equal(h.state().starts, 0);
    await h.integration.onboard();
});

test('configuration validates bot, requires allowlist and stores ciphertext only', async () => {
    const h = harness(['yes', token, '11,22']);
    await h.integration.onboard();
    await h.integration.start();
    assert.deepEqual(h.state().calls, ['getMe','getWebhookInfo','getUpdates']);
    assert.deepEqual(h.state().settings.telegram.allowedUserIds, ['11','22']);
    assert.doesNotMatch(JSON.stringify(h.state().settings), /dummy_token/);
    assert.equal(h.state().starts, 1);
    await h.integration.command('disconnect');
    assert.equal(h.state().settings.telegram.secret, undefined);
    assert.equal(h.state().settings.telegram.enabled, false);
    assert.equal(h.state().stops, 1);
});

test('invalid allowlists never enable the bot', async () => {
    for (const value of ['', '*', '-1', 'username', '9007199254740992']) assert.throws(() => parseUserIds(value));
    assert.deepEqual(parseUserIds('12,12 34'), ['12','34']);
    const h = harness(['yes', token, '*']);
    await assert.rejects(h.integration.onboard(), /numeric Telegram/);
    assert.equal(h.state().settings.telegram, undefined);
});

test('invalid tokens and existing webhooks do not replace saved configuration', async () => {
    const h = harness(['yes', token, '11']);
    h.integration.clientFactory = () => ({ call: async () => { throw new TelegramError(401); } });
    await assert.rejects(h.integration.onboard(), /401/);
    assert.deepEqual(h.state().settings, {});
    const hook = harness([token, '11']);
    hook.integration.clientFactory = () => ({ call: async (method) => method === 'getMe' ? { is_bot: true, username: 'bot' } : { url: 'https://example.invalid' } });
    await assert.rejects(hook.integration.configure(), /webhook/);
    assert.deepEqual(hook.state().settings, {});
});

test('HTTP errors and transport errors never expose bot tokens', async () => {
    const client = new TelegramClient(token, { fetchImpl: async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`); } });
    await assert.rejects(client.call('getMe'), (error) => { assert.doesNotMatch(error.message, /dummy_token/); return error.code === 'NETWORK'; });
    const limited = new TelegramClient(token, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 2 } }) }) });
    await assert.rejects(limited.call('getMe'), (error) => error.code === 429 && error.retryAfter === 2);
    assert.throws(() => new TelegramClient('invalid'), /format/);
});

test('long Telegram replies split safely and redact tokens', async () => {
    const sent = [];
    const client = new TelegramClient(token, { fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body).text); return { ok: true, json: async () => ({ ok: true, result: true }) }; } });
    await client.send(11, '😀'.repeat(2500) + token);
    assert.ok(sent.length > 1);
    assert.ok(sent.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
    assert.doesNotMatch(sent.join(''), /dummy_token/);
});

function message(text, id = 11, type = 'private') { return { message: { text, from: { id }, chat: { id, type } } }; }
function runtimeHarness() {
    const sent = [], requests = [];
    const runtime = new TelegramRuntime({ client: { send: async (id, text) => sent.push({ id, text }) }, allowedUserIds: ['11','22'], providerConfig: { model: 'test' }, prepareModel: async () => 'dummy-key',
        graphFactory: () => createAgentGraph({ tools: [], modelNode: async (state, config) => { requests.push({ state, config }); return { messages: [new AIMessage('Offline answer')] }; } }),
    });
    return { runtime, sent, requests };
}

test('unauthorized users, groups, and bot senders cannot reach the agent', async () => {
    const h = runtimeHarness();
    await h.runtime.handle(message('read files', 99));
    await h.runtime.handle(message('read files', 11, 'group'));
    const bot = message('read files'); bot.message.from.is_bot = true;
    await h.runtime.handle(bot);
    assert.equal(h.requests.length, 0); assert.equal(h.sent.length, 0);
});

test('remote commands work locally and reset only the authorized user context', async () => {
    const h = runtimeHarness();
    for (const text of ['/start','/help','/status','/unknown']) await h.runtime.handle(message(text));
    assert.equal(h.requests.length, 0);
    await h.runtime.handle(message('first'));
    await h.runtime.handle(message('second'));
    await h.runtime.handle(message('separate user', 22));
    assert.equal(h.requests[1].state.messages.filter((m) => m.getType() === 'human').length, 2);
    assert.equal(h.requests[2].state.messages.filter((m) => m.getType() === 'human').length, 1);
    assert.equal(h.requests[0].config.configurable.toolPolicy, 'read-only');
    assert.equal(await h.requests[0].config.configurable.askPermission(), false);
    await h.runtime.handle(message('/reset'));
    assert.equal(h.runtime.sessions.has('11'), false);
    assert.equal(h.runtime.sessions.has('22'), true);
});

test('polling records offsets before executing and stops gracefully', async () => {
    const sequence = [];
    const runtime = new TelegramRuntime({ allowedUserIds: ['11'], providerConfig: {}, saveOffset: async (offset) => sequence.push(offset),
        client: { call: async (_method, _body, signal) => {
            if (!sequence.length) return [{ update_id: 7, ...message('/start') }, { update_id: 7, ...message('/start') }];
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }, send: async () => sequence.push('sent') },
    });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.stop();
    assert.deepEqual(sequence, [8, 'sent']);
    assert.equal(runtime.status, 'Disconnected');
});

test('terminal authentication errors stop polling with an actionable status', async () => {
    const runtime = new TelegramRuntime({ allowedUserIds: ['11'], providerConfig: {}, client: { call: async () => { throw new TelegramError(401); } } });
    runtime.start(); await runtime.task;
    assert.match(runtime.status, /reconfigure/);
    await runtime.stop();
});

test('encrypted token vault round-trips without plaintext storage and rejects tampering', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-vault-test-'));
    try {
        const vault = new TokenVault({ directory });
        const secret = await vault.seal(token);
        assert.doesNotMatch(JSON.stringify(secret), /dummy_token/);
        assert.equal(await vault.open(secret), token);
        const damaged = Buffer.from(secret.value, 'base64'); damaged[damaged.length - 1] ^= 255;
        await assert.rejects(vault.open({ ...secret, value: damaged.toString('base64') }));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('network failures reconnect without discarding the next authorized update', async () => {
    let polls=0, sent=0;
    const runtime=new TelegramRuntime({allowedUserIds:['11'],providerConfig:{},client:{
        call:async(_method,_body,signal)=>{
            polls++;
            if(polls===1) throw new TelegramError('NETWORK');
            if(polls===2) return [{update_id:1,...message('/start')}];
            return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        },send:async()=>{sent++;},
    }});
    runtime.start();
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.ok(polls>=2);
    assert.equal(sent,1);
    await runtime.stop();
});

test('failed delivery never reruns an already committed agent turn', async()=>{
    let executed=0, polls=0;
    const runtime=new TelegramRuntime({allowedUserIds:['11'],providerConfig:{},prepareModel:async()=> 'dummy-key',
        graphFactory:()=>createAgentGraph({tools:[],modelNode:async()=>{executed++;return {messages:[new AIMessage('Answer')]};}}),
        client:{call:async(_method,_body,signal)=>{
            if(++polls<=2)return [{update_id:9,...message('hello')}];
            return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        },send:async()=>{throw new TelegramError('NETWORK');}},
    });
    runtime.start();
    await new Promise(resolve=>setTimeout(resolve,1150));
    await runtime.stop();
    assert.equal(executed,1);
});

test('configured bot/model secrets are redacted before entering conversation context',async()=>{
    let seen;
    const client=new TelegramClient(token,{fetchImpl:async()=>{throw new Error('No network');}});
    client.send=async()=>{};
    const modelKey='dummy-private-model-credential';
    const runtime=new TelegramRuntime({client,allowedUserIds:['11'],providerConfig:{model:'offline'},prepareModel:async()=>modelKey,
        graphFactory:()=>createAgentGraph({tools:[],modelNode:async(state)=>{seen=state.messages.at(-1).content;return{messages:[new AIMessage('Safe response')]};}})});
    await runtime.handle(message(`Example ${token} and ${modelKey}`));
    assert.doesNotMatch(seen,/dummy_token|dummy-private-model-credential/);
    assert.match(seen,/redacted/);
    await runtime.stop();
});

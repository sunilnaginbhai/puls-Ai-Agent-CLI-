import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AIMessage } from '@langchain/core/messages';
import { COMMANDS, COMMAND_NAMES, matchCommands, parseCommand, buildCommandPrompt, suggestCommandName } from '../../src/ui/commands.js';
import initializeSession from '../../src/agent/session.js';
import { createAgentGraph } from '../../src/agent/agent.graph.js';
import { createTerminal } from '../../src/ui/terminal.js';

test('slash catalog offers more than ten real commands with descriptions and usage', () => {
    assert.ok(COMMANDS.length > 10);
    assert.equal(new Set(COMMAND_NAMES).size, COMMANDS.length);
    assert.deepEqual(matchCommands('/'), COMMANDS);
    assert.deepEqual(matchCommands('/re').map(({ name }) => name), ['/review', '/refactor']);
    assert.deepEqual(matchCommands('/review src/main.js'), []);
    for (const command of COMMANDS) {
        assert.ok(command.description && command.usage);
        assert.ok(['local', 'prompt'].includes(command.kind));
        if (command.kind === 'prompt' && command.acceptsArgs) assert.ok(buildCommandPrompt(command, 'src/main.js').includes('src/main.js'));
    }
    assert.equal(parseCommand('/REVIEW src/main.js').definition.name, '/review');
    assert.equal(suggestCommandName('/statuz'), '/status');
    assert.equal(suggestCommandName(`/${'x'.repeat(10000)}`), undefined);
});

async function runSession(requests, { interactive = true, fail = false } = {}) {
    const input = new EventEmitter();
    const drafts = [];
    const calls = [];
    let text = '';
    const output = { isTTY: false, columns: 80, write(chunk) { text += chunk; } };
    input.isInteractive = interactive;
    input.history = ['/status', '/help'];
    input.setDraft = (draft) => drafts.push(draft);
    input.setFollowups = (suggestions) => { input.followups = suggestions; };
    input.readInput = async () => {
        const item = requests.shift() ?? '/bye';
        return typeof item === 'function' ? item({ drafts, input }) : item;
    };
    const graph = createAgentGraph({ tools: [], modelNode: async (state, config) => {
        calls.push({ messages: state.messages, policy: config.configurable.toolPolicy });
        if (fail) throw new Error('Offline test failure');
        return { messages: [new AIMessage('A clear explanation with an example.')] };
    } });
    const result = await initializeSession({ input, output, graph, terminal: createTerminal({ output, error: output }), providerConfig: { model: 'test-model', label: 'Test', timeoutMs: 1000 }, workspace: '/temporary-workspace' });
    return { ...result, text, drafts, calls, input };
}

test('all informational commands work locally without requesting a model', async () => {
    const result = await runSession(['/', '/model', '/workspace', '/history', '/followups', '/continue', '/review', '/status extra', '/new', '/bye']);
    assert.equal(result.calls.length, 0);
    for (const expected of ['Active model', 'test-model', '/temporary-workspace', 'Recent commands', '/review <file or task>', 'New conversation started']) assert.ok(result.text.includes(expected));
    assert.deepEqual(result.followups, []);
});

test('prompt shortcuts expand before model routing and retain read-only policy', async () => {
    const result = await runSession(['/review fix bugs in src/main.js', '/continue', '/bye']);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].policy, 'read-only');
    assert.equal(result.calls[1].policy, 'read-only');
    const request = result.calls[0].messages.at(-1).content;
    assert.match(request, /Review the following/);
    assert.match(request, /Target: fix bugs in src\/main\.js/);
    assert.ok(!request.startsWith('/review'));
});

test('follow-ups appear after success and numbered selection drafts without a model call', async () => {
    const result = await runSession(['Explain closures', '/1', '/followups', '/status', '/bye']);
    assert.equal(result.calls.length, 1);
    assert.equal(result.followups.length, 3);
    assert.match(result.text, /Suggested next steps/);
    assert.match(result.text, /Follow-up drafted/);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0], result.followups[0].prompt);
});

test('a drafted follow-up only runs when explicitly submitted as user input', async () => {
    const result = await runSession(['Explain closures', '/2', ({ drafts }) => drafts.at(-1), '/bye']);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[1].messages.at(-1).content, result.drafts[0]);
});

test('/new clears context, suggestions, and pending drafts', async () => {
    const result = await runSession(['Explain closures', '/1', '/new', '/1', 'Explain promises', '/bye']);
    assert.equal(result.calls.length, 2);
    assert.equal(result.turns, 1);
    assert.equal(result.drafts.at(-1), '');
    assert.equal(result.calls[1].messages.filter((message) => message.getType() === 'human').length, 1);
    assert.match(result.text, /Choose \/followups after an AI response/);
});

test('failed turns do not offer follow-ups or execute numbered selections', async () => {
    const result = await runSession(['Explain closures', '/1', '/bye'], { fail: true });
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.followups, []);
    assert.deepEqual(result.drafts, []);
    assert.doesNotMatch(result.text, /Suggested next steps/);
});

test('piped numbered selections preserve later commands and do not submit draft prompts', async () => {
    const result = await runSession(['Explain closures', '/1', '/status', '/bye'], { interactive: false });
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.drafts, []);
    assert.match(result.text, /Suggested prompt/);
    assert.match(result.text, /Session status/);
    assert.match(result.text, /Goodbye/);
    assert.doesNotMatch(result.text, /Suggested next steps/);
});

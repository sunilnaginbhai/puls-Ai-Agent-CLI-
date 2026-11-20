import test from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionPrompt } from '../../src/security/permission.prompt.js';

function harness(answers, interactive = true) {
    let text = '';
    const input = { isInteractive: interactive, question: async () => answers.shift() };
    const ask = createPermissionPrompt({ input, output: { write(value) { text += value; } } });
    return { ask, text: () => text };
}

test('piped input cannot approve writes even if it contains yes', async () => {
    const { ask, text } = harness(['yes'], false);
    assert.equal(await ask('write', 'file.js'), false);
    assert.match(text(), /non-interactive/);
});

test('approval defaults to no and requires an explicit yes', async () => {
    assert.equal(await harness(['']).ask('write', 'file.js'), false);
    assert.equal(await harness(['maybe', 'yes']).ask('write', 'file.js'), true);
});

test('permission text strips terminal control sequences and credentials', async () => {
    const { ask, text } = harness(['no']);
    await ask('write\x1b[2J', 'api_key=sk-secret1234567890');
    assert.doesNotMatch(text(), /\x1b|sk-secret1234567890/);
});

test('queued permission prompts honor cancellation before consuming an answer', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ask } = harness(['yes']);
    await assert.rejects(ask('write', 'file.js', { signal: controller.signal }), { name: 'AbortError' });
});

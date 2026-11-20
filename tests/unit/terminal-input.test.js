import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { TerminalInput, completeCommand } from '../../src/ui/readline.js';

const sink = () => new Writable({ write(chunk, encoding, done) { done(); } });

test('piped commands retain every line even when producer closes before next prompt', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    await input.initialize();
    source.end('/help\n/status\n/bye\n');
    assert.equal(await input.readInput(), '/help');
    assert.equal(await input.readInput(), '/status');
    assert.equal(await input.readInput(), '/bye');
    await assert.rejects(input.readInput(), { code: 'ERR_INPUT_NOT_OPEN' });
    await input.close();
});

test('multiline continuation preserves newlines and escaped trailing slashes', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    await input.initialize();
    source.end('first\\\nsecond\npath\\\\\n');
    assert.equal(await input.readInput(), 'first\nsecond');
    assert.equal(await input.readInput(), 'path\\\\');
    await input.close();
});

test('aborted question releases pending state and permits a subsequent prompt', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    const controller = new AbortController();
    const pending = input.question('', { signal: controller.signal });
    await input.initialize();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    source.end('recovered\n');
    assert.equal(await input.question(), 'recovered');
    await input.close();
});

test('slash completion suggests valid commands without leaking arbitrary prompts', () => {
    assert.deepEqual(completeCommand('/st'), [['/status'], '/st']);
    assert.deepEqual(completeCommand('/unknown'), [[], '/unknown']);
    assert.deepEqual(completeCommand('ordinary prompt'), [[], 'ordinary prompt']);
});

async function interactiveHarness(historyFile = null) {
    const source = new PassThrough();
    source.isTTY = true;
    source.setRawMode = () => source;
    let displayed = '';
    const output = new Writable({ write(chunk, encoding, done) { displayed += chunk; done(); } });
    output.isTTY = true;
    output.columns = 80;
    const input = new TerminalInput({ input: source, output, historyFile });
    const previousTerm = process.env.TERM;
    process.env.TERM = 'xterm';
    try { await input.initialize(); }
    finally {
        if (previousTerm === undefined) delete process.env.TERM;
        else process.env.TERM = previousTerm;
    }
    return { input, source, output, displayed: () => displayed };
}

test('interactive slash selection uses arrow keys and keeps readline cursor prompt aligned', async () => {
    const { input } = await interactiveHarness();
    const result = input.question('you > ');
    await input.initialize();
    assert.equal(input.interface.getPrompt(), 'you > ');
    input.interface.write('/');
    input.interface.write(null, { name: 'down' });
    assert.equal(input.interface.line, '/help');
    input.interface.write(null, { name: 'down' });
    assert.equal(input.interface.line, '/status');
    input.interface.write(null, { name: 'up' });
    assert.equal(input.interface.line, '/help');
    input.interface.write(null, { name: 'return' });
    assert.equal(await result, '/help');
    await input.close();
});

test('secret input is hidden and removed from readline history', async () => {
    const { input, displayed } = await interactiveHarness();
    const answer = input.question('API key: ', { secret: true });
    await input.initialize();
    input.interface.write('arbitrary-private-key');
    input.interface.write(null, { name: 'return' });
    assert.equal(await answer, 'arbitrary-private-key');
    assert.doesNotMatch(displayed(), /arbitrary-private-key/);
    assert.ok(!input.interface.history.includes('arbitrary-private-key'));
    await input.close();
});

test('background typing cannot redraw a prompt over streamed output', async () => {
    const { input, displayed } = await interactiveHarness();
    await input.initialize();
    input.setBusy(true);
    input.interface.write('stray typing');
    assert.equal(input.interface.line, '');
    assert.doesNotMatch(displayed(), /stray typing/);
    let cancelled = false;
    input.on('cancel', () => { cancelled = true; });
    input.interface.write(null, { name: 'c', ctrl: true });
    assert.equal(cancelled, true);
    await input.close();
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('persistent history restores commands and omits ordinary requests', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-history-test-'));
    const historyFile = path.join(directory, 'history.json');
    let input;
    try {
        ({ input } = await interactiveHarness(historyFile));
        input.lines.push('ordinary private request');
        assert.equal(await input.readInput(), 'ordinary private request');
        input.lines.push('/status');
        assert.equal(await input.readInput(), '/status');
        await input.close();
        assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')), ['/status']);
        ({ input } = await interactiveHarness(historyFile));
        assert.deepEqual(input.interface.history, ['/status']);
    } finally {
        await input?.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('a rapid interactive multiline paste retains continuation lines between prompts', async () => {
    const { input, source } = await interactiveHarness();
    try {
        const request = input.readInput();
        await input.initialize();
        source.write('first\\\nsecond\n');
        assert.equal(await request, 'first\nsecond');
    } finally { await input.close(); }
});

test('queued pasted commands cannot answer a later approval prompt', async () => {
    const { input, source } = await interactiveHarness();
    try {
        const request = input.readInput();
        await input.initialize();
        source.write('request\nyes\n');
        assert.equal(await request, 'request');
        assert.deepEqual(input.lines, ['yes']);
        let answered = false;
        const approval = input.question('Allow? ').then((value) => { answered = true; return value; });
        await input.initialize();
        assert.equal(answered, false);
        source.write('no\n');
        assert.equal(await approval, 'no');
        assert.equal(await input.readInput(), 'yes');
    } finally { await input.close(); }
});

test('piped EOF submits collected multiline content instead of losing it', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    await input.initialize();
    source.end('first\\\nsecond\\\n');
    assert.equal(await input.readInput(), 'first\nsecond');
    await assert.rejects(input.readInput(), { code: 'ERR_INPUT_NOT_OPEN' });
    await input.close();
});

test('cancellation while initializing does not consume a queued input line', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    let release;
    const opening = new Promise((resolve) => { release = resolve; });
    const open = input.open.bind(input);
    input.open = async () => { await opening; await open(); };
    input.lines.push('keep this request');
    const controller = new AbortController();
    const request = input.question('', { signal: controller.signal });
    controller.abort();
    release();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(await input.question(), 'keep this request');
    await input.close();
});

test('a pipe exceeding the configured queue limit fails explicitly and releases queued text', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null, maxQueuedLines: 2, maxQueuedBytes: 20 });
    await input.initialize();
    source.end('first\nsecond\nthird\nfourth\n');
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(input.readInput(), { code: 'ERR_INPUT_LIMIT' });
    assert.deepEqual(input.lines, []);
    assert.equal(input.queuedBytes, 0);
    assert.equal(input.closed, true);
    await input.close();
});

test('input stream errors reject the waiting prompt without an unhandled error event', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null });
    const request = input.question();
    await input.initialize();
    const failure = Object.assign(new Error('Input connection closed unexpectedly.'), { code: 'EIO' });
    source.emit('error', failure);
    await assert.rejects(request, { code: 'EIO' });
    await assert.rejects(input.question(), { code: 'EIO' });
    await input.close();
});

test('cancelled secret input cannot be redisplayed by the next prompt or retained in history', async () => {
    const { input, displayed } = await interactiveHarness();
    const controller = new AbortController();
    try {
        input.interface.history = ['/status', 'previous ordinary request'];
        const request = input.question('API key: ', { secret: true, signal: controller.signal });
        await input.initialize();
        input.interface.write('partially-entered-private-key');
        controller.abort();
        await assert.rejects(request, { name: 'AbortError' });
        assert.equal(input.interface.line, '');
        assert.deepEqual(input.interface.history, ['/status', 'previous ordinary request']);
        const next = input.readInput();
        await input.initialize();
        input.interface.write('/bye');
        input.interface.write(null, { name: 'return' });
        assert.equal(await next, '/bye');
        assert.doesNotMatch(displayed(), /partially-entered-private-key/);
    } finally { await input.close(); }
});

test('a pipe without a newline is bounded before readline finishes the line', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null, maxLineBytes: 8 });
    const request = input.readInput();
    await input.initialize();
    source.write('1234');
    source.write('56789');
    await assert.rejects(request, { code: 'ERR_INPUT_LIMIT' });
    assert.equal(input.closed, true);
    assert.equal(source.listenerCount('data'), 0);
    await input.close();
});

test('a continuously arriving multiline request cannot grow without a bound', async () => {
    const source = new PassThrough();
    const input = new TerminalInput({ input: source, output: sink(), historyFile: null, maxQueuedBytes: 12 });
    const request = input.readInput();
    const rejection = assert.rejects(request, { code: 'ERR_INPUT_LIMIT' });
    await input.initialize();
    for (const line of ['abcd\\\n', 'efgh\\\n', 'ijkl\\\n']) {
        source.write(line);
        await new Promise((resolve) => setImmediate(resolve));
    }
    await rejection;
    assert.equal(input.closed, true);
    await input.close();
});

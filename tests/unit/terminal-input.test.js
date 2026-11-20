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
    const { input, displayed } = await interactiveHarness();
    const result = input.readInput('you > ');
    await input.initialize();
    assert.equal(input.interface.getPrompt(), 'you > ');
    input.interface.write('/');
    assert.equal(input.menu.visible, true);
    assert.ok(input.menu.visibleCount >= 11);
    assert.match(displayed(), /\/refactor/);
    assert.match(displayed(), /\/followups/);
    input.interface.write(null, { name: 'down' });
    assert.equal(input.menuIndex, 1);
    assert.equal(input.interface.line, '/');
    input.interface.write(null, { name: 'up' });
    assert.equal(input.menuIndex, 0);
    input.interface.write(null, { name: 'return' });
    assert.equal(await result, '/help');
    assert.equal(input.menu.visible, false);
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

test('live command filtering and Enter complete a prompt shortcut without submitting it', async () => {
    const { input } = await interactiveHarness();
    try {
        let submitted = false;
        const result = input.readInput().then((text) => { submitted = true; return text; });
        await input.initialize();
        input.interface.write('/re');
        assert.deepEqual(input.commandMatches().map((command) => command.name), ['/review', '/refactor']);
        input.interface.write(null, { name: 'down' });
        input.interface.write(null, { name: 'return' });
        assert.equal(input.interface.line, '/refactor ');
        assert.equal(submitted, false);
        assert.equal(input.menu.visible, false);
        input.interface.write('src/example.js');
        input.interface.write(null, { name: 'return' });
        assert.equal(await result, '/refactor src/example.js');
    } finally { await input.close(); }
});

test('Tab fills a local command and Escape dismisses the menu without submitting', async () => {
    const { input } = await interactiveHarness();
    try {
        let submitted = false;
        const result = input.readInput().then((text) => { submitted = true; return text; });
        await input.initialize();
        input.interface.write('/sta');
        input.interface.write(null, { name: 'tab' });
        assert.equal(input.interface.line, '/status');
        assert.equal(submitted, false);
        assert.equal(input.menu.visible, false);
        input.interface.write(null, { name: 'backspace' });
        assert.equal(input.menu.visible, true);
        input.interface.write(null, { name: 'escape' });
        assert.equal(input.menu.visible, false);
        assert.equal(input.interface.line, '/statu');
        input.interface.write('s');
        assert.equal(input.menu.visible, true);
        input.interface.write(null, { name: 'return' });
        assert.equal(await result, '/status');
    } finally { await input.close(); }
});

test('approval and credential questions never display command suggestions', async () => {
    const { input, displayed } = await interactiveHarness();
    try {
        const approval = input.question('Allow? ');
        await input.initialize();
        input.interface.write('/');
        assert.equal(input.menu.visible, false);
        assert.doesNotMatch(displayed(), /Show commands and keyboard shortcuts/);
        input.interface.write(null, { name: 'return' });
        assert.equal(await approval, '/');
        const secret = input.question('API key: ', { secret: true });
        await input.initialize();
        input.interface.write('/private-entry');
        assert.equal(input.menu.visible, false);
        input.interface.write(null, { name: 'return' });
        assert.equal(await secret, '/private-entry');
        assert.doesNotMatch(displayed(), /private-entry/);
    } finally { await input.close(); }
});

test('draft suggestions are editable, one-shot, and cannot answer an approval prompt', async () => {
    const { input } = await interactiveHarness();
    try {
        assert.equal(input.setDraft('Explain the edge cases.'), true);
        const approval = input.question('Allow? ');
        await input.initialize();
        assert.equal(input.interface.line, '');
        input.interface.write('no');
        input.interface.write(null, { name: 'return' });
        assert.equal(await approval, 'no');
        let submitted = false;
        const request = input.readInput().then((text) => { submitted = true; return text; });
        await input.initialize();
        assert.equal(input.interface.line, 'Explain the edge cases.');
        assert.equal(submitted, false);
        input.interface.write(' Include examples.');
        input.interface.write(null, { name: 'return' });
        assert.equal(await request, 'Explain the edge cases. Include examples.');
        const next = input.readInput();
        await input.initialize();
        assert.equal(input.interface.line, '');
        input.interface.write('/bye');
        input.interface.write(null, { name: 'return' });
        assert.equal(await next, '/bye');
    } finally { await input.close(); }
});

test('contextual follow-up shortcuts join the slash menu and never auto-execute', async () => {
    const { input } = await interactiveHarness();
    try {
        input.setFollowups([{ label: 'Explain the proposed changes', prompt: 'Explain the proposed changes.' }]);
        const request = input.readInput();
        await input.initialize();
        input.interface.write('/1');
        assert.equal(input.commandMatches()[0].description, 'Explain the proposed changes');
        assert.equal(input.menu.visible, true);
        input.interface.write(null, { name: 'return' });
        assert.equal(await request, '/1');
        input.setFollowups([]);
        assert.deepEqual(input.followups, []);
    } finally { await input.close(); }
});

test('slash menu adapts to a narrow resize and removes its listener on close', async () => {
    const { input, output } = await interactiveHarness();
    const controller = new AbortController();
    try {
        const request = input.readInput('you > ', { signal: controller.signal });
        const rejection = assert.rejects(request, { name: 'AbortError' });
        await input.initialize();
        input.interface.write('/');
        assert.ok(input.menu.visibleCount >= 11);
        output.columns = 28;
        output.rows = 8;
        output.emit('resize');
        assert.ok(input.menu.visibleCount <= 4);
        assert.equal(input.menu.visible, true);
        controller.abort();
        await rejection;
        assert.equal(input.menu.visible, false);
    } finally { await input.close(); }
    assert.equal(output.listenerCount('resize'), 0);
});

test('NO_COLOR keeps menu styling plain while preserving cursor navigation', async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    const { input, displayed } = await interactiveHarness();
    try {
        const request = input.readInput();
        await input.initialize();
        input.interface.write('/status');
        input.interface.write(null, { name: 'return' });
        assert.equal(await request, '/status');
        assert.doesNotMatch(displayed(), /\u001b\[[0-9;]*m/);
    } finally {
        await input.close();
        if (previous === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previous;
    }
});

test('argument commands persist only their names and never the private target text', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-command-history-'));
    const historyFile = path.join(directory, 'history.json');
    const { input } = await interactiveHarness(historyFile);
    try {
        input.enqueue('/fix private/project-file.js');
        assert.equal(await input.readInput(), '/fix private/project-file.js');
        await input.historyWrite;
        assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')), ['/fix']);
    } finally {
        await input.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('dumb terminals keep slash input usable without drawing a suggestion palette', async () => {
    const source = new PassThrough();
    source.isTTY = true;
    source.setRawMode = () => source;
    let displayed = '';
    const output = new Writable({ write(chunk, encoding, done) { displayed += chunk; done(); } });
    output.isTTY = true;
    output.columns = 80;
    const previous = process.env.TERM;
    process.env.TERM = 'dumb';
    const input = new TerminalInput({ input: source, output, historyFile: null });
    try {
        const request = input.readInput();
        await input.initialize();
        source.write('/status\n');
        assert.equal(await request, '/status');
        assert.equal(input.menu.visible, false);
        assert.doesNotMatch(displayed, /Show model, workspace/);
        assert.doesNotMatch(displayed, /\u001b/);
    } finally {
        await input.close();
        if (previous === undefined) delete process.env.TERM;
        else process.env.TERM = previous;
    }
});

import { CommandMenu } from '../../src/ui/command-menu.js';
import { COMMANDS as COMMAND_DEFINITIONS } from '../../src/ui/commands.js';

test('opening the palette at the terminal bottom preserves the prompt and restores its cursor', () => {
    const columns = 80;
    const rows = 24;
    const screen = Array.from({ length: rows }, () => '');
    let row = rows - 1;
    let column = 7;
    screen[row] = 'you > /';
    const output = { columns, rows, isTTY: false, write(text) {
        for (let index = 0; index < text.length;) {
            const control = /^\u001b\[([0-9;]*)([ABCDJm])/.exec(text.slice(index));
            if (control) {
                const count = Number(control[1]) || 1;
                if (control[2] === 'A') row = Math.max(0, row - count);
                if (control[2] === 'B') row = Math.min(rows - 1, row + count);
                if (control[2] === 'C') column = Math.min(columns - 1, column + count);
                if (control[2] === 'D') column = Math.max(0, column - count);
                if (control[2] === 'J') {
                    screen[row] = screen[row].slice(0, column);
                    for (let next = row + 1; next < rows; next++) screen[next] = '';
                }
                index += control[0].length;
                continue;
            }
            const character = text[index++];
            if (character === '\n') {
                row++;
                if (row === rows) { screen.shift(); screen.push(''); row--; }
            } else if (character === '\r') column = 0;
            else {
                screen[row] = screen[row].padEnd(column, ' ').slice(0, column) + character + screen[row].slice(column + 1);
                column++;
            }
        }
    } };
    const readline = { line: '/', cursor: 1, getCursorPos: () => ({ rows: 0, cols: 7 }) };
    const menu = new CommandMenu({ output, readline });
    menu.render(COMMAND_DEFINITIONS);
    const promptRow = row;
    assert.equal(screen[row], 'you > /');
    assert.equal(column, 7);
    assert.ok(screen.slice(row + 1).some((line) => line.includes('/review')));
    menu.hide();
    assert.equal(row, promptRow);
    assert.equal(column, 7);
    assert.equal(screen[row], 'you > /');
    assert.ok(screen.slice(row + 1).every((line) => line === ''));
});

test('queued user input supersedes a selected draft instead of reviving it later', async () => {
    const { input } = await interactiveHarness();
    try {
        input.setDraft('Explain the earlier response.');
        input.enqueue('Handle this newer request instead.');
        assert.equal(await input.readInput(), 'Handle this newer request instead.');
        assert.equal(input.draft, undefined);
        const next = input.readInput();
        await input.initialize();
        assert.equal(input.interface.line, '');
        input.interface.write('/bye');
        input.interface.write(null, { name: 'return' });
        assert.equal(await next, '/bye');
    } finally { await input.close(); }
});

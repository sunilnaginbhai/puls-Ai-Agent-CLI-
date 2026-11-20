import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(args, input, home) {
    const env = { ...process.env, PULS_HOME: home, PULS_PROVIDER: 'openai', NO_COLOR: '1' };
    for (const name of ['PULS_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GOOGLE_API_KEY', 'PULS_MODEL', 'PULS_REQUEST_TIMEOUT_MS']) delete env[name];
    return spawnSync(process.execPath, ['cli.js', ...args], { input, encoding: 'utf8', env, timeout: 30000 });
}

test('CLI help/version run without credentials and command pipe exits with complete output', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-cli-test-'));
    try {
        const help = run(['--help', '--no-color'], '', home);
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /\/status/);
        assert.doesNotMatch(help.stdout, /\u001b/);
        const version = run(['--version'], '', home);
        assert.equal(version.status, 0, version.stderr);
        assert.match(version.stdout, /1\.0\.0/);
        const commands = run([], '/help\n/status\n/unknown\n/clear\n/bye\n', home);
        assert.equal(commands.status, 0, commands.stderr);
        assert.match(commands.stdout, /Session status/);
        assert.match(commands.stdout, /Unknown command/);
        assert.match(commands.stdout, /Goodbye/);
        assert.equal(commands.stderr, '');
        await assert.rejects(fs.access(path.join(home, '.puls-ai', 'settings.json')));
    } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('missing provider credentials fail a piped AI request without hanging or consuming commands', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-cli-fail-test-'));
    try {
        const response = run([], 'Hello\n/bye\n', home);
        assert.equal(response.status, 1);
        assert.match(response.stderr, /OPENAI_API_KEY|PULS_API_KEY/);
        assert.match(response.stdout, /Goodbye/);
        assert.doesNotMatch(response.stderr, /\u001b/);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
});

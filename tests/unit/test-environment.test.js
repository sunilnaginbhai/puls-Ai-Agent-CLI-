import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('test preload isolates eager settings imports and removes inherited credentials', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-profile-fixture-'));
    const settingsPath = path.join(fixture, '.puls-ai', 'settings.json');
    const sentinel = JSON.stringify({ apiKey: 'test-fixture-only', theme: 'preserve' });
    try {
        await fs.mkdir(path.dirname(settingsPath));
        await fs.writeFile(settingsPath, sentinel);
        const script = `
            import { getSettingsFile, saveApiKey } from './src/config/settings.store.js';
            import { CONFIG_DIR } from './src/config/paths.js';
            await saveApiKey('disposable-test-key');
            const settings = await getSettingsFile();
            console.log(JSON.stringify({
                directory: CONFIG_DIR,
                isolated: settings.apiKey === 'disposable-test-key',
                credentialsRemoved: !['PULS_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'FREELLMAPI_API_KEY', 'LANGSMITH_API_KEY'].some(name => process.env[name]),
                tracingDisabled: process.env.LANGCHAIN_TRACING_V2 === 'false' && process.env.LANGSMITH_TRACING === 'false',
            }));
        `;
        const child = spawnSync(process.execPath, ['--import', './scripts/test-environment.js', '--input-type=module', '--eval', script], {
            encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PULS_HOME: fixture, PULS_AI_WORKSPACE: fixture,
                PULS_API_KEY: 'must-not-be-inherited', GROQ_API_KEY: 'must-not-be-inherited',
                OPENAI_API_KEY: 'must-not-be-inherited', GOOGLE_API_KEY: 'must-not-be-inherited',
                OPENROUTER_API_KEY: 'must-not-be-inherited', FREELLMAPI_API_KEY: 'must-not-be-inherited',
                LANGSMITH_API_KEY: 'must-not-be-inherited' },
        });
        assert.equal(child.status, 0, 'Isolated settings subprocess must exit successfully.');
        const result = JSON.parse(child.stdout);
        assert.equal(result.isolated, true);
        assert.equal(result.credentialsRemoved, true);
        assert.equal(result.tracingDisabled, true);
        assert.notEqual(path.dirname(result.directory), fixture);
        await assert.rejects(fs.access(path.dirname(result.directory)), { code: 'ENOENT' });
        assert.equal(await fs.readFile(settingsPath, 'utf8'), sentinel);
    } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

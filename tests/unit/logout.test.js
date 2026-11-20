import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { confirmLogout } from '../../src/security/logout.js';

function fixture(answers, interactive = true) {
    let removed = 0, cleared = 0, text = '';
    const input = { isInteractive: interactive, history: ['/logout'], historyWrite: Promise.resolve(), question: async () => answers.shift() };
    return { input, run: () => confirmLogout({ input, output: { write(value) { text += value; } }, clearData: async () => { removed++; }, clearCredentials: () => { cleared++; } }), state: () => ({ removed, cleared, text }) };
}

test('logout requires explicit yes and supports no or empty cancellation', async () => {
    for (const answer of ['no', 'n', '']) {
        const f = fixture([answer]);
        assert.equal(await f.run(), false);
        assert.equal(f.state().removed, 0);
        assert.equal(f.state().cleared, 0);
    }
    const f = fixture(['invalid', 'yes']);
    assert.equal(await f.run(), true);
    assert.equal(f.state().removed, 1);
    assert.equal(f.state().cleared, 1);
    assert.deepEqual(f.input.history, []);
});

test('piped yes cannot delete saved data', async () => {
    const f = fixture(['yes'], false);
    assert.equal(await f.run(), false);
    assert.equal(f.state().removed, 0);
});

test('Ctrl+C cancels logout without deleting data', async () => {
    const f = fixture([]);
    f.input.question = async () => { throw Object.assign(new Error('cancel'), { code: 'INPUT_CANCELLED' }); };
    assert.equal(await f.run(), false);
    assert.equal(f.state().removed, 0);
});

test('logout waits for pending history writes and reports deletion failures', async () => {
    const order = [];
    const input = { isInteractive: true, question: async () => 'yes', historyWrite: Promise.resolve().then(() => order.push('history')) };
    await assert.rejects(confirmLogout({ input, output: { write() {} }, clearData: async () => { order.push('delete'); throw new Error('locked profile'); }, clearCredentials: () => order.push('credentials') }), /locked profile/);
    assert.deepEqual(order, ['history', 'delete']);
});

test('confirmed logout removes all local profile data, preserves workspace, and forgets cached credentials', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'puls-logout-test-'));
    try {
        await fs.mkdir(path.join(home, '.puls-ai', 'nested'), { recursive: true });
        await fs.writeFile(path.join(home, '.puls-ai', 'history.json'), '["/logout"]');
        await fs.writeFile(path.join(home, '.puls-ai', 'nested', 'local.txt'), 'local data');
        await fs.writeFile(path.join(home, 'project.txt'), 'preserve workspace');
        const script = `
            import {saveApiKey,getApiKey} from './src/config/settings.store.js';
            import {confirmLogout} from './src/security/logout.js';
            import {ensureProviderApiKey,getProviderApiKey} from './src/providers/provider.manager.js';
            await saveApiKey('dummy-logout-key',{provider:'openai'});
            const config={provider:'openai',label:'OpenAI',keyEnv:'OPENAI_API_KEY'};
            await ensureProviderApiKey(null,{config,interactive:false});
            const ok=await confirmLogout({input:{isInteractive:true,question:async()=> 'yes',historyWrite:Promise.resolve()},output:{write(){}}});
            const cached=await getApiKey({provider:'openai',validate:false});
            let providerForgot=false;
            try{await getProviderApiKey({config});}catch{providerForgot=true;}
            console.log(JSON.stringify({ok,forgot:!!cached.error,providerForgot}));
        `;
        const env = { ...process.env, PULS_HOME: home };
        for (const key of ['PULS_API_KEY','OPENAI_API_KEY','GROQ_API_KEY','GOOGLE_API_KEY','OPENROUTER_API_KEY','FREELLMAPI_API_KEY']) delete env[key];
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8', timeout: 30000 });
        assert.equal(child.status, 0, 'Logout subprocess must succeed');
        assert.deepEqual(JSON.parse(child.stdout), { ok: true, forgot: true, providerForgot: true });
        // Key lookup may recreate an empty settings file, but never credentials/history.
        const settings = JSON.parse(await fs.readFile(path.join(home,'.puls-ai','settings.json'),'utf8'));
        assert.deepEqual(settings, {});
        await assert.rejects(fs.access(path.join(home,'.puls-ai','history.json')));
        await assert.rejects(fs.access(path.join(home,'.puls-ai','nested')));
        assert.equal(await fs.readFile(path.join(home,'project.txt'),'utf8'), 'preserve workspace');
    } finally { await fs.rm(home,{recursive:true,force:true}); }
});

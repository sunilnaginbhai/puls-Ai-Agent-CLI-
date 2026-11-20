import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousHome = process.env.PULS_HOME;
const previousApiKey = process.env.PULS_API_KEY;
const previousSkipValidation = process.env.PULS_SKIP_API_KEY_VALIDATION;
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "puls-ai-settings-test-"));
process.env.PULS_HOME = temporaryHome;
process.env.PULS_API_KEY = "dummy-test-api-key";
delete process.env.PULS_SKIP_API_KEY_VALIDATION;

const { CONFIG_DIR } = await import('../../src/config/paths.js');
assert.equal(CONFIG_DIR, path.join(temporaryHome, '.puls-ai'), 'Settings tests must use the temporary home before any settings I/O.');
const { getApiKey, getSettingsFile, saveApiKey, validateApiKey } = await import("../../src/config/settings.store.js");
const settingsPath = path.join(temporaryHome, ".puls-ai", "settings.json");

after(async () => {
    await fs.rm(temporaryHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PULS_HOME;
    else process.env.PULS_HOME = previousHome;
    if (previousApiKey === undefined) delete process.env.PULS_API_KEY;
    else process.env.PULS_API_KEY = previousApiKey;
    if (previousSkipValidation === undefined) delete process.env.PULS_SKIP_API_KEY_VALIDATION;
    else process.env.PULS_SKIP_API_KEY_VALIDATION = previousSkipValidation;
});

test("returns the session key without repeating provider validation", async () => {
    const result = await getApiKey({ validate: false });

    assert.deepEqual(result, { apiKey: "dummy-test-api-key" });
});

test("does not overwrite malformed settings JSON", async () => {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const malformed = "{ broken settings";
    await fs.writeFile(settingsPath, malformed, "utf8");

    await assert.rejects(getSettingsFile(), /Unable to read Puls AI settings/i);
    assert.equal(await fs.readFile(settingsPath, "utf8"), malformed);
});

test('provider credentials are isolated and concurrent saves preserve settings', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ apiKey: 'legacy-groq-key', theme: 'minimal' }));
    await Promise.all([
        saveApiKey('openai-private-value', { provider: 'openai' }),
        saveApiKey('google-private-value', { provider: 'google' }),
    ]);
    const settings = await getSettingsFile();
    assert.equal(settings.apiKey, 'legacy-groq-key');
    assert.equal(settings.theme, 'minimal');
    assert.equal(settings.providers.openai.apiKey, 'openai-private-value');
    assert.equal(settings.providers.google.apiKey, 'google-private-value');
});

test('malformed settings errors never echo secret JSON contents', async () => {
    await fs.writeFile(settingsPath, '{"apiKey":"arbitrary-sensitive-value" BROKEN');
    await assert.rejects(getSettingsFile(), (error) => {
        assert.doesNotMatch(error.message, /arbitrary-sensitive-value/);
        assert.match(error.message, /Invalid JSON/);
        return true;
    });
});

test('pre-cancelled key validation exits before making a network request', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(validateApiKey('dummy-key', { signal: controller.signal }), { name: 'AbortError' });
});

test('a leftover temporary settings file cannot block or be deleted by a new save', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'preserve' }));
    const leftover = `${settingsPath}.${process.pid}.tmp`;
    await fs.writeFile(leftover, 'leftover from an interrupted save');
    await saveApiKey('temporary-test-key', { provider: 'openai' });
    const settings = await getSettingsFile();
    assert.equal(settings.theme, 'preserve');
    assert.equal(settings.providers.openai.apiKey, 'temporary-test-key');
    assert.equal(await fs.readFile(leftover, 'utf8'), 'leftover from an interrupted save');
    const entries = await fs.readdir(path.dirname(settingsPath));
    assert.equal(entries.filter((name) => name.endsWith('.tmp')).length, 1);
});

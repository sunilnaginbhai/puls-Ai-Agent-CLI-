import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './paths.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const sessionApiKeys = new Map();
let settingsWrite = Promise.resolve();

export async function updateSettings(update) {
    const write = settingsWrite.then(async () => {
        const settings = await getSettingsFile();
        const updated = await update(settings);
        const temporaryFile = `${SETTINGS_FILE}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporaryFile, JSON.stringify(updated, null, 2), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporaryFile, SETTINGS_FILE);
        } finally { await fs.rm(temporaryFile, { force: true }); }
        return updated;
    });
    settingsWrite = write.catch(() => undefined);
    return write;
}

/** Delete only Puls's own local profile after the caller confirms logout. */
export async function clearLocalData() {
    const reset = settingsWrite.then(async () => {
        const target = path.resolve(CONFIG_DIR);
        if (path.basename(target) !== '.puls-ai' || target === path.parse(target).root) throw new Error('Invalid Puls profile path.');
        try {
            if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Logout cannot delete a linked Puls profile directory.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rm(target, { recursive: true, force: true });
        sessionApiKeys.clear();
    });
    settingsWrite = reset.catch(() => undefined);
    return reset;
}

export async function getSettingsFile() {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

    try {
        const content = await fs.readFile(SETTINGS_FILE, 'utf-8');
        const settings = JSON.parse(content || '{}');
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new Error('Settings file must contain a JSON object.');
        }
        return settings;
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.writeFile(SETTINGS_FILE, '{}', { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
            } catch (writeError) {
                if (writeError.code !== 'EEXIST') throw writeError;
                return getSettingsFile();
            }
            return {};
        }

        const detail = error instanceof SyntaxError ? 'Invalid JSON; repair the settings file before retrying.' : error.message;
        throw new Error(`Unable to read Puls AI settings: ${detail}`);
    }
}

export async function saveApiKey(apiKey, { provider = 'groq' } = {}) {
    const normalizedKey = String(apiKey ?? '').trim();

    if (!normalizedKey) {
        throw new Error('API key cannot be empty.');
    }

    await updateSettings((settingsContent) => provider === 'groq'
        ? { ...settingsContent, activeProvider: provider, apiKey: normalizedKey }
        : { ...settingsContent, activeProvider: provider, providers: { ...settingsContent.providers, [provider]: { ...settingsContent.providers?.[provider], apiKey: normalizedKey } } });
    sessionApiKeys.set(provider, normalizedKey);
    return normalizedKey;
}

export async function validateApiKey(apiKey, { signal } = {}) {
    signal?.throwIfAborted();
    const normalizedKey = String(apiKey ?? '').trim();

    if (!normalizedKey) {
        return { error: 'API key not found. Please set your API key to continue.' };
    }

    if (process.env.PULS_SKIP_API_KEY_VALIDATION === '1') {
        return { apiKey: normalizedKey };
    }

    try {
        await axios.get('https://api.groq.com/openai/v1/models', {
            headers: {
                Authorization: `Bearer ${normalizedKey}`,
            },
            timeout: 10000,
            signal,
        });

        return { apiKey: normalizedKey };
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const status = error?.response?.status;
        if (status === 429) {
            return { error: 'Groq rate-limited API-key validation. Wait briefly and try again.' };
        }
        if (status && status !== 401 && status !== 403) {
            return { error: `Groq API-key validation failed with HTTP ${status}. Try again later.` };
        }
        if (!status && (error?.code || error?.request)) {
            return { error: 'Could not reach Groq to validate the API key. Check your connection and try again.' };
        }
        return {
            error: 'Invalid API key. Please set a valid API key to continue.',
        };
    }
}

export async function getApiKey({ validate = true, provider = 'groq' } = {}) {
    const envApiKey = String(process.env.PULS_API_KEY ?? '').trim();
    let storedApiKey = '';
    const sessionApiKey = sessionApiKeys.get(provider);
    if (!sessionApiKey && !envApiKey) {
        const settings = await getSettingsFile();
        storedApiKey = String((provider === 'groq' ? settings.apiKey : settings.providers?.[provider]?.apiKey) ?? '').trim();
    }
    const apiKey = sessionApiKey || envApiKey || storedApiKey;

    if (!apiKey) {
        return {
            error: 'API key not found. Please set your API key using the CLI prompt or by exporting PULS_API_KEY.',
        };
    }

    if (!validate || provider !== 'groq') {
        return { apiKey };
    }

    return validateApiKey(apiKey);
}

export async function ensureApiKey(promptForKey) {
    const result = await getApiKey();

    if (!result.error) {
        sessionApiKeys.set('groq', result.apiKey);
        return result.apiKey;
    }

    if (!/API key not found|Invalid API key/i.test(result.error)) {
        throw new Error(result.error);
    }

    const apiKey = await promptForKey();
    const normalizedKey = String(apiKey ?? '').trim();

    if (!normalizedKey) {
        throw new Error('API key cannot be empty.');
    }

    const validation = await validateApiKey(normalizedKey);
    if (validation.error) {
        throw new Error(validation.error);
    }

    await saveApiKey(normalizedKey);
    sessionApiKeys.set('groq', normalizedKey);
    return normalizedKey;
}

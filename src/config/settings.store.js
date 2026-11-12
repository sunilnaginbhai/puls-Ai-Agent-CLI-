import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { CONFIG_DIR } from './paths.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

export async function getSettingsFile() {
    try {
        await fs.access(CONFIG_DIR);
    } catch {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
    }

    try {
        await fs.access(SETTINGS_FILE);
        const content = await fs.readFile(SETTINGS_FILE, 'utf-8');
        return JSON.parse(content || '{}');
    } catch {
        await fs.writeFile(SETTINGS_FILE, JSON.stringify({}, null, 2));
        return {};
    }
}

export async function saveApiKey(apiKey) {
    const normalizedKey = String(apiKey ?? '').trim();

    if (!normalizedKey) {
        throw new Error('API key cannot be empty.');
    }

    const settingsContent = await getSettingsFile();
    await fs.writeFile(
        SETTINGS_FILE,
        JSON.stringify({
            ...settingsContent,
            apiKey: normalizedKey,
        }, null, 2)
    );

    return normalizedKey;
}

export async function validateApiKey(apiKey) {
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
        });

        return { apiKey: normalizedKey };
    } catch {
        return {
            error: 'Invalid API key. Please set a valid API key to continue.',
        };
    }
}

export async function getApiKey() {
    const settingsContent = await getSettingsFile();
    const envApiKey = String(process.env.PULS_API_KEY ?? '').trim();
    const storedApiKey = String(settingsContent.apiKey ?? '').trim();
    const apiKey = envApiKey || storedApiKey;

    if (!apiKey) {
        return {
            error: 'API key not found. Please set your API key using the CLI prompt or by exporting PULS_API_KEY.',
        };
    }

    return validateApiKey(apiKey);
}

export async function ensureApiKey(promptForKey) {
    const result = await getApiKey();

    if (!result.error) {
        return result.apiKey;
    }

    const apiKey = await promptForKey();
    const normalizedKey = String(apiKey ?? '').trim();

    if (!normalizedKey) {
        throw new Error('API key cannot be empty.');
    }

    await saveApiKey(normalizedKey);

    const validation = await getApiKey();
    if (validation.error) {
        throw new Error(validation.error);
    }

    return validation.apiKey;
}

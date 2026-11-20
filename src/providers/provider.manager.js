import { getApiKey, saveApiKey, validateApiKey } from "../config/settings.store.js";
import { getProviderConfig } from "./provider.config.js";

const sessionKeys = new Map();

export function clearProviderSession() {
    sessionKeys.clear();
    for (const name of ['PULS_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY', 'FREELLMAPI_API_KEY']) delete process.env[name];
}

/** Resolve provider-specific keys before the backwards-compatible Puls key. */
export async function getProviderApiKey({
    config = getProviderConfig(), env = process.env, getKey = getApiKey,
} = {}) {
    const environmentKey = String(env[config.keyEnv] ?? "").trim() || String(env.PULS_API_KEY ?? "").trim();
    const cachedKey = sessionKeys.get(config.provider);
    if (environmentKey || cachedKey) return environmentKey || cachedKey;
    const result = await getKey({ validate: false, provider: config.provider });
    if (result?.apiKey) return result.apiKey;
    throw new Error(`API key not found for ${config.label}. Set ${config.keyEnv} or PULS_API_KEY.`);
}

/** Validate Groq keys once; other SDKs authenticate when the first request runs. */
export async function ensureProviderApiKey(promptForKey, {
    config = getProviderConfig(), env = process.env,
    interactive = process.stdin.isTTY === true,
    getKey = getApiKey, validateKey = validateApiKey, saveKey = saveApiKey,
    signal,
} = {}) {
    signal?.throwIfAborted();
    let apiKey;
    let shouldSave = false;
    try {
        apiKey = await getProviderApiKey({ config, env, getKey });
    } catch (error) {
        if (!/API key not found/.test(error.message)) throw error;
    }

    signal?.throwIfAborted();
    if (apiKey && config.provider === "groq" && sessionKeys.get(config.provider) !== apiKey) {
        const validation = await validateKey(apiKey, { signal });
        signal?.throwIfAborted();
        if (validation.error) {
            if (!/Invalid API key|API key not found/i.test(validation.error)) throw new Error(validation.error);
            apiKey = undefined;
        }
    }

    if (!apiKey) {
        if (!interactive || typeof promptForKey !== "function") {
            throw new Error(`API key not found for ${config.label}. Set ${config.keyEnv} or PULS_API_KEY before running Puls AI.`);
        }
        apiKey = String(await promptForKey(config) ?? "").trim();
        signal?.throwIfAborted();
        if (!apiKey) throw new Error("API key cannot be empty.");
        shouldSave = true;
        if (config.provider === "groq") {
            const validation = await validateKey(apiKey, { signal });
            signal?.throwIfAborted();
            if (validation.error) throw new Error(validation.error);
        }
    }

    signal?.throwIfAborted();
    if (shouldSave) await saveKey(apiKey, { provider: config.provider });
    sessionKeys.set(config.provider, apiKey);
    return apiKey;
}

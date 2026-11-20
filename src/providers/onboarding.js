import { getSettingsFile } from '../config/settings.store.js';
import { getProviderConfig } from './provider.config.js';
import { getProviderApiKey, ensureProviderApiKey } from './provider.manager.js';
import { registerSecret } from '../ui/sanitize.js';

/** Authenticate a new interactive profile before presenting the chat prompt. */
export async function prepareStartup({ input, output = process.stdout, env = process.env,
    readSettings = getSettingsFile, getKey = getProviderApiKey, ensureKey = ensureProviderApiKey } = {}) {
    const settings = await readSettings();
    let config = getProviderConfig({ ...env, PULS_PROVIDER: env.PULS_PROVIDER || settings.activeProvider || 'groq' });
    if (!input.isInteractive) return { config };
    try {
        await getKey({ config, env });
        return { config };
    } catch (error) {
        if (!/API key not found/i.test(error.message)) throw error;
    }
    output.write('\nSet up Puls AI\n\n  1  Groq\n  2  Google Gemini\n  3  OpenAI\n  4  OpenRouter (free models available)\n  5  FreeLLMAPI (free model router)\n\n');
    const choices = {
        '1': 'groq', groq: 'groq',
        '2': 'google', google: 'google', gemini: 'google', 'google gemini': 'google',
        '3': 'openai', openai: 'openai',
        '4': 'openrouter', openrouter: 'openrouter',
        '5': 'freellmapi', freellmapi: 'freellmapi', 'free llm api': 'freellmapi',
    };
    while (true) {
        const answer = String(await input.question('Choose a provider [1-5 or name]: ')).trim().toLowerCase();
        const provider = choices[answer];
        if (!provider) { output.write('Choose Groq, Google Gemini, OpenAI, OpenRouter, or FreeLLMAPI.\n'); continue; }
        config = getProviderConfig({ ...env, PULS_PROVIDER: provider });
        break;
    }
    const apiKey = await ensureKey(
        () => input.question(`Enter your ${config.provider === 'google' ? 'Google Gemini' : config.label} API key (hidden): `, { secret: true }),
        { config, env, interactive: true },
    );
    registerSecret(apiKey);
    output.write('Provider configured.\n');
    return { config, apiKey };
}

const PROVIDERS = Object.freeze({
    groq: { label: "Groq", model: "openai/gpt-oss-120b", keyEnv: "GROQ_API_KEY" },
    openai: { label: "OpenAI", model: "gpt-4.1-mini", keyEnv: "OPENAI_API_KEY" },
    google: { label: "Google", model: "gemini-2.5-flash", keyEnv: "GOOGLE_API_KEY" },
});

/** Public session metadata. Never include credentials in this object. */
export function getProviderConfig(env = process.env) {
    const provider = String(env.PULS_PROVIDER || "groq").trim().toLowerCase();
    const defaults = PROVIDERS[provider];
    if (!defaults) {
        throw new Error(`Unsupported provider "${provider}". Set PULS_PROVIDER to groq, openai, or google.`);
    }

    const timeoutMs = env.PULS_REQUEST_TIMEOUT_MS === undefined
        ? 120_000 : Number(env.PULS_REQUEST_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
        throw new Error("PULS_REQUEST_TIMEOUT_MS must be an integer from 1000 to 600000.");
    }

    const model = String(env.PULS_MODEL || defaults.model).trim();
    if (!model || /[\x00-\x1f\x7f]/.test(model)) {
        throw new Error("PULS_MODEL must be a nonempty model identifier without control characters.");
    }
    return Object.freeze({ provider, label: defaults.label, model, keyEnv: defaults.keyEnv, timeoutMs });
}

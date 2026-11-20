import test from "node:test";
import assert from "node:assert/strict";
import { getProviderConfig } from "../../src/providers/provider.config.js";
import { getProviderApiKey, ensureProviderApiKey } from "../../src/providers/provider.manager.js";
import { createModel } from "../../src/providers/model.factory.js";

test("provider config preserves the existing default and supports explicit provider/model choices", () => {
    assert.equal(getProviderConfig({}).provider, "groq");
    assert.equal(getProviderConfig({}).model, "openai/gpt-oss-120b");
    const config = getProviderConfig({ PULS_PROVIDER: "OpenAI", PULS_MODEL: "chosen-model", OPENAI_API_KEY: "secret" });
    assert.equal(config.provider, "openai");
    assert.equal(config.model, "chosen-model");
    assert.equal(config.keyEnv, "OPENAI_API_KEY");
    assert.equal(JSON.stringify(config).includes("secret"), false);
});

test("OpenRouter defaults to free-model routing and its OpenAI-compatible API endpoint", () => {
    const config = getProviderConfig({ PULS_PROVIDER: "openrouter" });
    assert.equal(config.provider, "openrouter");
    assert.equal(config.model, "openrouter/free");
    assert.equal(config.keyEnv, "OPENROUTER_API_KEY");
    assert.equal(config.baseURL, "https://openrouter.ai/api/v1");
});

test("FreeLLMAPI uses its router model and OpenAI-compatible API endpoint", () => {
    const config = getProviderConfig({ PULS_PROVIDER: "freellmapi" });
    assert.equal(config.provider, "freellmapi");
    assert.equal(config.model, "auto");
    assert.equal(config.keyEnv, "FREELLMAPI_API_KEY");
    assert.equal(config.baseURL, "https://api.freellmapi.com/v1");
});

test("invalid provider, timeout, and model values fail before starting a request", () => {
    assert.throws(() => getProviderConfig({ PULS_PROVIDER: "unsupported" }), /Unsupported provider/);
    for (const timeout of ["abc", "0", "10000000", "1.5"]) {
        assert.throws(() => getProviderConfig({ PULS_REQUEST_TIMEOUT_MS: timeout }), /PULS_REQUEST_TIMEOUT_MS/);
    }
    assert.throws(() => getProviderConfig({ PULS_MODEL: "  " }), /PULS_MODEL/);
    assert.throws(() => getProviderConfig({ PULS_MODEL: "model\x1b[2J" }), /PULS_MODEL/);
});

test("provider-specific environment keys take precedence without settings access", async () => {
    const apiKey = await getProviderApiKey({
        config: getProviderConfig({ PULS_PROVIDER: "openai" }),
        env: { OPENAI_API_KEY: "specific", PULS_API_KEY: "generic" },
        getKey: () => { throw new Error("Must not read settings"); },
    });
    assert.equal(apiKey, "specific");
});

test("missing credentials in a pipe fail without prompting", async () => {
    let prompted = false;
    await assert.rejects(ensureProviderApiKey(() => { prompted = true; }, {
        config: getProviderConfig({ PULS_PROVIDER: "google" }), env: {}, interactive: false,
        getKey: async (options) => {
            assert.equal(options.provider, "google");
            return { error: "API key not found" };
        },
    }), /GOOGLE_API_KEY/);
    assert.equal(prompted, false);
});

test("non-Groq credentials never contact Groq for validation", async () => {
    const apiKey = await ensureProviderApiKey(() => { throw new Error("Must not prompt"); }, {
        config: getProviderConfig({ PULS_PROVIDER: "openai" }), env: { OPENAI_API_KEY: "openai-test" },
        validateKey: () => { throw new Error("Must not validate against Groq"); },
    });
    assert.equal(apiKey, "openai-test");
});

test("factory creates the requested installed provider adapter without a network request", async () => {
    for (const provider of ["groq", "openai", "google", "openrouter", "freellmapi"]) {
        const config = getProviderConfig({ PULS_PROVIDER: provider });
        const model = await createModel({ config, apiKey: "offline-test-key", maxTokens: 1024 });
        assert.equal(model.model ?? model.modelName, config.model);
        assert.equal(typeof model.stream, "function");
        if (provider === "openrouter" || provider === "freellmapi") {
            assert.equal(model.clientConfig.baseURL, config.baseURL);
        }
    }
});

test("validates a configured Groq key once for the session", async () => {
    let validations = 0;
    const options = {
        config: getProviderConfig({}), env: { GROQ_API_KEY: "groq-session-test" },
        validateKey: async (apiKey) => { validations += 1; return { apiKey }; },
    };
    await ensureProviderApiKey(undefined, options);
    await ensureProviderApiKey(undefined, options);
    assert.equal(validations, 1);
});

test("new provider credentials are saved with their provider scope", async () => {
    let saved;
    const apiKey = await ensureProviderApiKey(async () => " google-prompt-test ", {
        config: getProviderConfig({ PULS_PROVIDER: "google" }), env: {}, interactive: true,
        getKey: async () => ({ error: "API key not found" }),
        saveKey: async (...args) => { saved = args; },
    });
    assert.equal(apiKey, "google-prompt-test");
    assert.deepEqual(saved, ["google-prompt-test", { provider: "google" }]);
});

test("credential validation forwards cancellation and never prompts or saves after abort", async () => {
    const controller = new AbortController();
    const pending = ensureProviderApiKey(() => { throw new Error("Must not prompt"); }, {
        config: getProviderConfig({}), env: { GROQ_API_KEY: "groq-cancel-test" }, signal: controller.signal,
        validateKey: async (_key, { signal }) => {
            assert.equal(signal, controller.signal);
            controller.abort(new DOMException("Cancelled", "AbortError"));
            return { error: "Invalid API key" };
        },
        saveKey: () => { throw new Error("Must not save"); },
    });
    await assert.rejects(pending, { name: "AbortError" });
});

test('blank provider-specific keys do not suppress the generic environment key', async () => {
    const key = await getProviderApiKey({
        config: getProviderConfig({ PULS_PROVIDER: 'openai' }),
        env: { OPENAI_API_KEY: '   ', PULS_API_KEY: ' fallback-test-key ' },
        getKey: () => { throw new Error('Must not read settings'); },
    });
    assert.equal(key, 'fallback-test-key');
});

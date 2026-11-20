import { getProviderConfig } from "./provider.config.js";

/** Load only the selected provider SDK to keep startup light. */
export async function createModel({ config = getProviderConfig(), apiKey, maxTokens = 1024 }) {
    const options = {
        model: config.model,
        apiKey,
        maxRetries: 1,
        timeout: config.timeoutMs,
        ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}),
    };
    switch (config.provider) {
        case "groq": {
            const { ChatGroq } = await import("@langchain/groq");
            return new ChatGroq({ ...options, maxTokens });
        }
        case "openai":
        case "openrouter":
        case "freellmapi": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({ ...options, maxTokens });
        }
        case "google": {
            const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
            return new ChatGoogleGenerativeAI({ ...options, maxOutputTokens: maxTokens });
        }
        default:
            throw new Error(`Unsupported model provider: ${config.provider}`);
    }
}

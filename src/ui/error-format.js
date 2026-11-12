// Formats model and provider errors for terminal display.

export function formatError(error) {
    const message = String(error?.message ?? error ?? "Unknown error");
    const status = Number(
        error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        error?.cause?.status
    );
    const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
    const lowerMessage = message.toLowerCase();

    if (
        status === 429 ||
        code === "RATE_LIMIT_EXCEEDED" ||
        /\b429\b/.test(message) ||
        lowerMessage.includes("rate_limit_exceeded")
    ) {
        return {
            title: "Rate limit reached",
            message: "The AI provider is temporarily limiting requests.",
            nextStep:
                "Wait for the limit to reset. Before retrying, check whether a file tool already completed.",
        };
    }

    if (status === 401 || status === 403) {
        return {
            title: status === 401 ? "Authentication failed" : "Access denied",
            message:
                status === 401
                    ? "The provider rejected the API key."
                    : "The provider denied access to this model or service.",
            nextStep: "Check the API key, provider account, and model access.",
        };
    }

    if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
        return {
            title: "Connection refused",
            message: "Puls AI could not connect to the configured service.",
            nextStep: "Confirm the service is running and the host and port are correct.",
        };
    }

    if (
        ["ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
        /timed?\s*out|timeout/i.test(message)
    ) {
        return {
            title: "Connection timed out",
            message: "The service did not respond in time.",
            nextStep: "Check your connection and try again in a moment.",
        };
    }

    if (status >= 500) {
        return {
            title: "Provider server error",
            message: `The AI provider returned HTTP ${status}.`,
            nextStep: "Wait briefly and try again. Do not automatically rerun file operations.",
        };
    }

    return {
        title: "Request failed",
        message,
        nextStep: "If this keeps happening, run with PULS_AI_DEBUG=1 for diagnostic details.",
    };
}

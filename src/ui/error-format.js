// Formats model and provider errors for terminal display.
import { sanitizeOutput } from "./sanitize.js";

export function formatError(error) {
    const message = sanitizeOutput(error?.message ?? error ?? "Unknown error").slice(0, 2000);
    const status = Number(
        error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        error?.cause?.status
    );
    const code = String(error?.code ?? error?.cause?.code ?? "").toUpperCase();
    const lowerMessage = message.toLowerCase();

    if (code === 'ERR_INPUT_LIMIT') {
        return {
            title: 'Input limit reached',
            message: 'The pending terminal input exceeded its safety limit.',
            nextStep: 'Split large requests or piped input into smaller batches, then restart Puls AI.',
        };
    }

    if (error?.name === 'GraphRecursionError' || code === 'GRAPH_RECURSION_LIMIT' || /recursion limit.*reached/i.test(message)) {
        return {
            title: 'Agent step limit reached',
            message: 'The agent stopped after too many model or tool steps.',
            nextStep: 'Review completed tool activity, then request a smaller task with specific file paths. Approved changes are not automatically repeated.',
        };
    }

    if (error?.name === "AbortError" || code === "ABORT_ERR" || /request cancelled|request canceled/i.test(message)) {
        return {
            title: "Request cancelled",
            message: "The request was interrupted.",
            nextStep: "Check completed tool activity before retrying a file change.",
        };
    }

    if (["EACCES", "EPERM"].includes(code)) {
        return {
            title: "Filesystem permission denied",
            message: "Puls AI could not access a file or directory.",
            nextStep: "Check workspace access and whether another application has locked the file.",
        };
    }

    if (code === "ENOSPC") {
        return {
            title: "Disk is full",
            message: "The filesystem has no space left for this operation.",
            nextStep: "Free disk space, then check the affected files before retrying.",
        };
    }

    if (
        /failed to parse tool call arguments as json/i.test(message) ||
        /tool choice is none/i.test(message)
    ) {
        return {
            title: "Tool call unavailable",
            message: "The model produced invalid tool arguments or requested a tool that was not enabled. No file operation ran for this call.",
            nextStep: "Retry with the file name and destination stated clearly. For a Desktop path outside the current workspace, set PULS_AI_WORKSPACE to the Desktop folder before starting Puls AI.",
        };
    }

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
        nextStep: "For diagnostics in PowerShell, set $env:PULS_AI_DEBUG = '1' before running npm start.",
    };
}

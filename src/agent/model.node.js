import { getProviderConfig } from "../providers/provider.config.js"
import { getProviderApiKey } from "../providers/provider.manager.js"
import { createModel } from "../providers/model.factory.js"
import { applyFileOperationsTool, listDirectoryTool, readFileTool, scanDirectoryTool } from "../tools/files/file.tools.js"
import { getRoutingMessageText, selectToolsForMessage } from "./tool-router.js"
/**
 * Handles the LLM node logic for the state graph.
 * @param {Object} state - The current state of the graph.
 * @returns {Promise<Object>} - The updated state after processing.
 */
export async function LLMNode(state, config = {}) {
    config.signal?.throwIfAborted()
    const toolCatalog = {
        applyFileOperations: applyFileOperationsTool,
        listDirectory: listDirectoryTool,
        readFile: readFileTool,
        scanDirectory: scanDirectoryTool,
    }
    const latestUserMessage = getRoutingMessageText(state.messages)
    const toolNames = selectToolsForMessage(latestUserMessage)
    const tools = toolNames.map((name) => toolCatalog[name])
    const maxTokens = toolNames.includes("applyFileOperations") ? 4096 : 1024
    const providerConfig = config.configurable?.providerConfig ?? getProviderConfig()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("Model request timed out.")), providerConfig.timeoutMs)
    timeout.unref?.()
    const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal
    let aiMessage
    try {
        signal.throwIfAborted()
        const apiKey = config.configurable?.apiKey ?? await withSignal(() => getProviderApiKey({ config: providerConfig }), signal)
        const modelFactory = config.configurable?.modelFactory ?? createModel
        const model = await withSignal(() => modelFactory({ config: providerConfig, apiKey, maxTokens, signal }), signal)
        // General questions get no file tools; file requests get only relevant tools.
        const modelwithTools = tools.length > 0
            ? model.bindTools(tools, providerConfig.provider === "google" ? {} : { parallel_tool_calls: false })
            : model
        const stream = await modelwithTools.stream(state.messages, { ...config, signal })
        for await (const chunk of stream) {
            signal.throwIfAborted()
            aiMessage = aiMessage ? aiMessage.concat(chunk) : chunk
            const text = contentToText(chunk.content)
            if (text) await config.configurable?.onToken?.(text)
        }
        signal.throwIfAborted()
        if (!aiMessage || (!contentToText(aiMessage.content) && !aiMessage.tool_calls?.length)) {
            if (aiMessage?.invalid_tool_calls?.length) throw new Error("The model returned invalid tool arguments. No tool from this response was executed; retry with specific file paths.")
            throw new Error("The model returned an empty response stream.")
        }
        validateCompletedResponse(aiMessage)
        return { messages: [aiMessage] }
    } catch (error) {
        if (controller.signal.aborted && !config.signal?.aborted) {
            const timeoutError = new Error("Model request timed out. Retry the request or increase PULS_REQUEST_TIMEOUT_MS.")
            timeoutError.code = "ETIMEDOUT"
            throw timeoutError
        }
        throw error
    } finally {
        clearTimeout(timeout)
    }
}

// SDK loading and credential resolution must share the request's cancellation
// boundary. Late resolutions/rejections remain observed after an abort.
function withSignal(operation, signal) {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        Promise.resolve().then(() => {
            signal.throwIfAborted()
            return operation()
        }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
}

function validateCompletedResponse(message) {
    const finishReason = String(message.response_metadata?.finish_reason ?? message.response_metadata?.finishReason ?? "").toLowerCase()
    if (["length", "max_tokens", "max_output_tokens"].includes(finishReason)) {
        const error = new Error("The model reached its output limit before completing this response. No tool from this response was executed. Retry with a smaller task or file change.")
        error.code = "MODEL_OUTPUT_TRUNCATED"
        throw error
    }
    if (message.invalid_tool_calls?.length) {
        throw new Error("The model returned invalid tool arguments. No tool from this response was executed; retry with specific file paths.")
    }
    // LangChain deliberately parses partial JSON during streaming. Only fully
    // closed arguments may cross from a completed model turn into execution.
    for (const call of message.tool_call_chunks ?? []) {
        try {
            const args = JSON.parse(call.args)
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected an object")
        } catch {
            throw new Error("The model returned incomplete or invalid tool arguments. No tool from this response was executed; retry with a smaller file change.")
        }
    }
}

function contentToText(content) {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content.map((part) => typeof part === "string" ? part : (part?.type === "text" ? part.text ?? "" : "")).join("")
}

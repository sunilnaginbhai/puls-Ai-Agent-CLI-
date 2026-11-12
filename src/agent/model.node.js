import { ChatGroq } from "@langchain/groq"
import { getApiKey } from "../config/settings.store.js"
import { applyFileOperationsTool, listDirectoryTool, readFileTool, scanDirectoryTool } from "../tools/files/file.tools.js"
import { ChatGoogle } from "@langchain/google"
/**
 * Handles the LLM node logic for the state graph.
 * @param {Object} state - The current state of the graph.
 * @returns {Promise<Object>} - The updated state after processing.
 */
export async function LLMNode(state, config) {
    const model = new ChatGroq({
        model: "openai/gpt-oss-120b",
        apiKey: (await getApiKey()).apiKey,
        maxTokens: 1024,
    });

    // const model = new ChatGoogle({
    //     model: "gpt-4o",
    //     apiKey: (await getApiKey()).apiKey,
    // })

    const tools = [applyFileOperationsTool, listDirectoryTool, readFileTool, scanDirectoryTool]

    const modelwithTools = model.bindTools(tools, { parallel_tool_calls: false })

    const stream = await modelwithTools.stream(state.messages)
    let aiMessage

    for await (const chunk of stream) {
        aiMessage = aiMessage ? aiMessage.concat(chunk) : chunk
    }

    if (!aiMessage) {
        throw new Error("The model returned an empty response stream.")
    }

    return {
        messages: [aiMessage]
    }
}

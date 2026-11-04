import { ChatGroq } from "@langchain/groq"
import { getApiKey } from "../utils/file.utils.js"
import { upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool } from "../tools/file.tools.js"

/**
 * Handles the LLM node logic for the state graph.
 * @param {Object} state - The current state of the graph.
 * @returns {Promise<Object>} - The updated state after processing.
 */
export async function LLMNode(state, config) {

    const model = new ChatGroq({
        model: "openai/gpt-oss-120b",
        apiKey: (await getApiKey()).apiKey,
    })

    const modelwithTools = model.bindTools([upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool])

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
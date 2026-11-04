import { MessagesAnnotation, StateGraph, START } from "@langchain/langgraph"
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt"
import { LLMNode } from "./node.js"
import { HumanMessage, SystemMessage } from "langchain"
import { upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool, } from "../tools/file.tools.js"
import rl from "../utils/readline.js"
import {
    startSpinner,
    stopSpinner,
    failSpinner
} from "../utils/spinner.js";

const graph = new StateGraph(MessagesAnnotation)
    .addNode("LLMNode", LLMNode)
    .addNode("tools", new ToolNode([upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool]))
    .addEdge(START, "LLMNode")
    .addConditionalEdges("LLMNode", toolsCondition)
    .addEdge("tools", "LLMNode")
    .compile();



export default async function initializeGraph() {

    let messages = [
        new SystemMessage(`
                - You are a helpful assistant that can perform file operations and answer questions.
                - You have access to the following tools:
                    1. upsertFiles: Create/Update multiple files at once (create one if not existed)
                    2. listDirectory: List all files and folders inside a specified directory.
                    3. createDirectory: Create a new directory or nested directories.
                    4. moveFile: Move a file from its current location to another location.
                    5. scanDirectory: Recursively scan a directory and return file names, extensions, sizes and folder information.
                - You can use these tools to assist the user with their requests.
                - Never repeat a tool call that the user denied or that already succeeded.
                - Do not move hidden files or files named only with an extension (for example, ".jpg") based on an assumed file type.
                - Stop using tools once the requested task is complete.
            `)
    ]

    while (true) {
        const userInput = await rl.question("[User]: ");

        if (userInput.toLowerCase() === "/bye") {
            break;
        }
        messages.push(new HumanMessage(userInput));
        // Start loading spinner
        startSpinner();
        try {
            const response = await graph.invoke(
                {
                    messages
                },
                {
                    context: {
                        username: "sunil"
                    }
                }
            );

            // Stop spinner after response
            stopSpinner();

            messages = response.messages;

            console.log("\n[AI]:", messages.at(-1).content);

        } catch (error) {
            failSpinner("Something went wrong!");
            console.error(error.message);
        }
    }

}
import { MessagesAnnotation, StateGraph, START } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "langchain";
import { LLMNode } from "./model.node.js";
import { upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool } from "../tools/files/file.tools.js";
import rl from "../ui/readline.js";
import { startSpinner, stopSpinner, failSpinner } from "../ui/spinner.js";
import { formatAssistantResponse } from "../ui/markdown.js";
import chalk from "chalk";
import { formatError } from "../ui/error-format.js";

const HELP_TEXT = `
Puls AI Commands:
  /help       Show the command list
  /status     Check current session status
  /clear      Clear the terminal
  /bye        Exit the assistant
`;

const graph = new StateGraph(MessagesAnnotation)
    .addNode("LLMNode", LLMNode)
    .addNode("tools", new ToolNode([upsertFilesTool, listDirectoryTool, createDirectoryTool, moveFileTool, scanDirectoryTool]))
    .addEdge(START, "LLMNode")
    .addConditionalEdges("LLMNode", toolsCondition)
    .addEdge("tools", "LLMNode")
    .compile();


/**
 * - You have access to the following tools:
            1. upsertFiles: Create/Update multiple files at once (create one if not existed)
            2. listDirectory: List all files and folders inside a specified directory.
            3. createDirectory: Create a new directory or nested directories.
            4. moveFile: Move a file from its current location to another location.
            5. scanDirectory: Recursively scan a directory and return file names, extensions, sizes and folder information.
            Never repeat a tool call that the user denied or that already succeeded.
        - Do not move hidden files or files named only with an extension (for example, ".jpg") based on an assumed file type.
        - Stop using tools once the requested task is complete.
 */

export default async function initializeGraph() {
    let messages = [
        new SystemMessage(`
            - You are a helpful assistant that can perform file operations and answer questions.
            - You can use these tools to assist the user with their requests.
        `)
    ];

    while (true) {
        let userInput;

        try {
            userInput = await rl.question("[User]: ");
        } catch (error) {
            if (error && error.code === 'ERR_INPUT_NOT_OPEN' || error && error.code === 'ERR_USE_AFTER_CLOSE') {
                console.log('\nInput stream closed. Exiting Puls AI...');
                break;
            }
            throw error;
        }

        const trimmedInput = String(userInput ?? '').trim();

        if (!trimmedInput) {
            continue;
        }

        if (trimmedInput.toLowerCase() === '/bye') {
            console.log('Goodbye!');
            break;
        }

        if (trimmedInput.toLowerCase() === '/help') {
            console.log(HELP_TEXT);
            continue;
        }

        if (trimmedInput.toLowerCase() === '/status') {
            console.log('Puls AI is ready. Workspace status: connected and listening for requests.');
            continue;
        }

        if (trimmedInput.toLowerCase() === '/clear') {
            console.clear();
            continue;
        }

        messages.push(new HumanMessage(trimmedInput));
        startSpinner();

        try {
            const response = await graph.invoke(
                { messages },
                { context: { username: 'sunil' } }
            );

            stopSpinner();
            messages = response.messages;

            const latestMessage = messages.at(-1);
            if (latestMessage?.content != null) {
                process.stdout.write("\n[AI]:\n");
                process.stdout.write(`${formatAssistantResponse(latestMessage.content)}\n\n`);
            } else {
                console.log("\n[AI]: I processed that request.\n");
            }


        } catch (error) {
            const formatted = formatError(error);

            failSpinner(formatted.title);
            console.error(chalk.red(`  ${formatted.message}`));

            if (formatted.nextStep) {
                console.error(chalk.gray(`  Next: ${formatted.nextStep}`));
            }

            if (process.env.PULS_AI_DEBUG === "1" && error?.stack) {
                console.error(chalk.gray(error.stack));
            }
        }

    }
}

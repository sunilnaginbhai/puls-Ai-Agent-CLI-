import rl from "../ui/readline.js";
import initializeGraph from "../agent/agent.graph.js";
import { ensureApiKey } from "../config/settings.store.js";

function printBanner() {
    console.clear();
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                 Puls AI CLI - Local Coding Agent         ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");
    console.log("Type /help to see available commands, or /bye to exit.\n");
}

async function main() {
    printBanner();

    try {
        await ensureApiKey(async () => {
            const key = await rl.question("Please enter your API key: ");
            return key;
        });

        await initializeGraph();
    } catch (error) {
        if (error && (error.code === 'ERR_INPUT_NOT_OPEN' || error.code === 'ERR_USE_AFTER_CLOSE')) {
            console.log('Input closed. Exiting gracefully.');
            return;
        }

        console.error(`\nStartup failed: ${error.message || error}\n`);
        process.exitCode = 1;
    }
}

export default main;

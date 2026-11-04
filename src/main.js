import { saveApiKey, getApiKey } from "./utils/file.utils.js"
import rl from "./utils/readline.js"
import initializeGraph from "./graph/graph.js"

async function main() {
    try {
        let response = await getApiKey();
        let attempts = 0;

        while (response.error && attempts < 3) {
            console.error(response.error);
            const apiKey = await rl.question("Please enter your API key: ");
            await saveApiKey(apiKey.trim());
            attempts += 1;
            response = await getApiKey();
        }

        if (response.error) {
            throw new Error(`Could not validate API key after 3 attempts: ${response.error}`);
        }

        // return response.apiKey;
    } finally {
        await initializeGraph();
        rl.close();
    }
}

export default main;
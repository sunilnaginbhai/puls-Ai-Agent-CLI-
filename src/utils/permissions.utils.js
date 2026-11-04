
import rl from "./readline.js";
import chalk from "chalk";
import { pauseSpinner, resumeSpinner } from "./spinner.js";

let permissionQueue = Promise.resolve();

export function askPermission(action, details) {
    const request = permissionQueue.then(() => requestPermission(action, details));
    permissionQueue = request.then(() => undefined, () => undefined);
    return request;
}

async function requestPermission(action, details) {
    const resumeThinking = pauseSpinner();

    try {
        console.log("\n");
        console.log(chalk.yellow.bold("  ⚠ PERMISSION REQUIRED"));
        console.log(chalk.gray("  ─────────────────────────────────"));

        console.log(
            chalk.cyan("  Action: ") + chalk.white(action)
        );

        console.log(
            chalk.cyan("  Details: ") + chalk.white(details)
        );

        console.log(chalk.gray("  ─────────────────────────────────"));

        while (true) {
            const answer = await rl.question(
                chalk.yellow.bold("\n  Allow this operation? ") +
                chalk.green("[Y] Yes ") +
                chalk.red("[N] No ") +
                chalk.gray(": ")
            );

            const choice = answer.trim().toLowerCase();

            if (choice === "y" || choice === "yes") {
                console.log(chalk.green("Operation approved."));
                return true;
            }

            if (choice === "n" || choice === "no") {
                console.log(chalk.red.bold("\n  ✖ Operation cancelled by user.\n"));
                return false;
            }

            console.log(chalk.red("  Invalid input. Enter y or n."));
        }
    } finally {
        if (resumeThinking) resumeSpinner();
    }
}

import ora from "ora";
import { sanitizeOutput } from "./sanitize.js";
import { supportsColor } from "./terminal.js";

let spinner;
let spinnerMessage = "Thinking...";
let requested = false;

export function startSpinner(message = "Thinking...") {
    spinner?.stop();

    spinnerMessage = sanitizeOutput(message).replace(/\n/g, " ");
    requested = true;
    // Piped transcripts should contain meaningful events, never animation.
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY || process.env.TERM === "dumb") return;
    spinner = ora({
        text: spinnerMessage,
        spinner: process.platform === "win32" ? "line" : "dots",
        color: supportsColor(process.stderr) ? "cyan" : false,
        isEnabled: true,
        isSilent: false,
        discardStdin: false,
        hideCursor: false,
    }).start();
}

export function pauseSpinner() {
    const wasRequested = requested;
    spinner?.stop();
    requested = false;
    return wasRequested;
}

export function resumeSpinner() {
    if (!spinner?.isSpinning) {
        startSpinner(spinnerMessage);
    }
}

export function updateSpinner(message) {
    spinnerMessage = sanitizeOutput(message).replace(/\n/g, " ");
    if (spinner?.isSpinning) {
        spinner.text = spinnerMessage;
    }
}

export function stopSpinner(message) {
    requested = false;
    if (spinner?.isSpinning) {
        if (message) spinner.succeed(sanitizeOutput(message));
        else spinner.stop();
    }
    spinner = undefined;
}

export function failSpinner(message) {
    requested = false;
    if (spinner?.isSpinning) {
        if (message) spinner.fail(sanitizeOutput(message));
        else spinner.stop();
    }
    spinner = undefined;
}

import ora from "ora";

let spinner;
let spinnerMessage = "Thinking...";

export function startSpinner(message = "Thinking...") {
    if (spinner?.isSpinning) {
        spinner.stop();
    }

    spinnerMessage = message;
    spinner = ora({
        text: message,
        spinner: "dots",
        color: "cyan",
    }).start();
}

export function pauseSpinner() {
    const wasSpinning = Boolean(spinner?.isSpinning);
    if (wasSpinning) spinner.stop();
    return wasSpinning;
}

export function resumeSpinner() {
    if (!spinner?.isSpinning) {
        startSpinner(spinnerMessage);
    }
}

export function updateSpinner(message) {
    if (spinner?.isSpinning) {
        spinner.text = message;
    }
}

export function stopSpinner(message) {
    if (spinner?.isSpinning) {
        spinner.succeed(message);
    }
}

export function failSpinner(message) {
    if (spinner?.isSpinning) {
        spinner.fail(message);
    }
}

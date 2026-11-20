import rl from '../ui/readline.js';
import { pauseSpinner, resumeSpinner } from '../ui/spinner.js';
import { sanitizeOutput } from '../ui/terminal.js';

/** Serial prompts, explicit consent, and a safe denial for pipes/CI. */
export function createPermissionPrompt({ input = rl, output = process.stdout } = {}) {
    let queue = Promise.resolve();
    return function ask(action, details, { signal } = {}) {
        const request = queue.then(async () => {
            signal?.throwIfAborted();
            if (!input.isInteractive) {
                output.write('Approval required: file changes were declined because input is non-interactive. Run Puls AI in a terminal to review the plan.\n');
                return false;
            }
            const resume = pauseSpinner();
            try {
                output.write(`\nApproval required · ${sanitizeOutput(action)}\n${sanitizeOutput(details)}\n\n`);
                while (true) {
                    const answer = await input.question('Apply these changes? [y/N] ', { signal });
                    if (/^(y|yes)$/i.test(answer.trim())) {
                        output.write('Approved.\n');
                        return true;
                    }
                    if (!answer.trim() || /^(n|no)$/i.test(answer.trim())) {
                        output.write('Declined. No planned changes applied.\n');
                        return false;
                    }
                    output.write('Enter y to approve or n to decline.\n');
                }
            } catch (error) {
                if (['INPUT_CANCELLED', 'ERR_INPUT_NOT_OPEN', 'ERR_USE_AFTER_CLOSE'].includes(error?.code)) return false;
                throw error;
            } finally {
                if (resume && !signal?.aborted) resumeSpinner();
            }
        });
        queue = request.catch(() => undefined);
        return request;
    };
}

export const askPermission = createPermissionPrompt();

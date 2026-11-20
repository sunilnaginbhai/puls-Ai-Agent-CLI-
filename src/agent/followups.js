import { sanitizeOutput } from '../ui/sanitize.js';

const SUGGESTIONS = {
    changes: [
        {
            label: 'Review the changes',
            prompt: 'Read the current files changed in the previous turn and review them for bugs, regressions, and edge cases. Explain findings before proposing any further edits.',
        },
        {
            label: 'Plan regression checks',
            prompt: 'Inspect the changed code and relevant test files, then propose focused regression tests and exact commands I can run locally. Do not claim any tests were executed.',
        },
        {
            label: 'Explain the changes',
            prompt: 'Explain the confirmed file changes from the previous turn, how they affect behavior, and any remaining limitations. Read the current files when needed.',
        },
    ],
    debugging: [
        {
            label: 'Trace the root cause',
            prompt: 'Read the relevant project code and explain the root cause of the problem discussed above. Separate confirmed evidence from hypotheses and recommend a minimal correction before any edits.',
        },
        {
            label: 'Check related edge cases',
            prompt: 'Inspect the relevant code for related failure cases and explain which inputs or conditions could trigger them. Keep this response to analysis and recommendations.',
        },
        {
            label: 'Plan a regression test',
            prompt: 'Inspect the relevant project test files and propose a focused regression test for the issue above. Include the exact command I can run; do not claim it has been executed.',
        },
    ],
    testing: [
        {
            label: 'Find missing test cases',
            prompt: 'Review the testing approach in your previous answer for missing edge cases. Explain which additional checks would give the most confidence and why.',
        },
        {
            label: 'Plan test additions',
            prompt: 'Inspect the relevant project test files and plan focused additions to cover the remaining risks. Propose the changes for review before any file edits.',
        },
        {
            label: 'Show verification commands',
            prompt: 'Read the project configuration and relevant test files, then list exact verification commands for me to run locally. Clearly state that you have not executed them.',
        },
    ],
    review: [
        {
            label: 'Prioritize the findings',
            prompt: 'Prioritize the review findings from the previous answer by impact and confidence. Explain the evidence for each finding and keep this response to recommendations.',
        },
        {
            label: 'Plan the smallest correction',
            prompt: 'Plan a minimal set of code changes for the highest-priority review findings. Include tradeoffs, risks, and verification steps; wait for my review before any file edits.',
        },
        {
            label: 'Recommend regression tests',
            prompt: 'Read the relevant project test files and recommend regression tests for the review findings. Include commands I can run and clearly distinguish suggested checks from executed tests.',
        },
    ],
    planning: [
        {
            label: 'Break the plan into steps',
            prompt: 'Turn the proposal in your previous answer into ordered implementation steps, with a clear verification check after each step. Keep this response to planning only.',
        },
        {
            label: 'Compare the tradeoffs',
            prompt: 'Compare the main alternatives for the proposal above. Explain the tradeoffs, likely risks, and the smallest useful starting point.',
        },
        {
            label: 'Define acceptance checks',
            prompt: 'Propose concrete acceptance checks for the plan above, including expected behavior and important edge cases. These are proposed checks, not executed tests.',
        },
    ],
    workspace: [
        {
            label: 'Choose files to inspect',
            prompt: 'Based on the workspace listing above, suggest the most relevant existing files to read next and explain why. Keep this response to a plan.',
        },
        {
            label: 'Explain the project structure',
            prompt: 'Inspect the relevant existing project files and explain how the main modules fit together. Separate confirmed relationships from assumptions.',
        },
        {
            label: 'Identify verification checks',
            prompt: 'Read the existing project configuration and recommend useful verification commands for me to run. Do not claim any commands or tests were executed.',
        },
    ],
    code: [
        {
            label: 'Walk through an example',
            prompt: 'Use the code discussed above to walk through a concrete input and its result step by step. Read the relevant existing files when needed.',
        },
        {
            label: 'Review edge cases',
            prompt: 'Review the code discussed above for edge cases, error handling, and common mistakes. Explain the findings and propose improvements before any file edits.',
        },
        {
            label: 'Suggest focused tests',
            prompt: 'Read the relevant existing code and test files, then suggest focused test cases for the behavior discussed above. Include verification commands without claiming they were executed.',
        },
    ],
    general: [
        {
            label: 'Show a concrete example',
            prompt: 'Give a small, concrete example of the concept in your previous answer and walk through the result.',
        },
        {
            label: 'Explore common mistakes',
            prompt: 'Explain edge cases and common mistakes related to your previous answer, using short examples.',
        },
        {
            label: 'Suggest practical next steps',
            prompt: 'Suggest three practical next steps based on your previous answer, including a clear first action to take.',
        },
    ],
};

function textContent(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map((block) => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '').join('\n');
}

/** Local suggestions only. Never copy untrusted response/source text into a prompt. */
export function suggestFollowups({ userText = '', assistantText = '', toolNames = [], fileOperations = [] } = {}) {
    const request = textContent(userText);
    const answer = textContent(assistantText);
    const tools = new Set(Array.isArray(toolNames) ? toolNames : []);
    const changedFiles = Array.isArray(fileOperations) && fileOperations.some((operation) =>
        operation?.status === 'complete' && ['write_file', 'create_directory', 'move_file'].includes(operation.type));
    let category;
    if (changedFiles) category = 'changes';
    else if (/\b(?:tests?|testing|coverage|regression|specs?)\b/i.test(request)) category = 'testing';
    else if (/\b(?:debug|crash|exception|stack\s*trace|error|broken|bugs?|failures?)\b/i.test(request)
        || /\b(?:root cause|stack trace|uncaught exception)\b/i.test(answer)) category = 'debugging';
    else if (/\b(?:review|audit|security)\b/i.test(request) || /\breview findings\b/i.test(answer)) category = 'review';
    else if (/\b(?:plan|design|architecture|approach|roadmap)\b/i.test(request)
        || tools.has('applyFileOperations')) category = 'planning';
    else if ((tools.has('listDirectory') || tools.has('scanDirectory')) && !tools.has('readFile')) category = 'workspace';
    else if (tools.has('readFile') || /```[^\n]*\n/.test(answer)
        || /\b(?:code|function|class|module|source|script)\b/i.test(request)) category = 'code';
    else category = 'general';
    return SUGGESTIONS[category].map(({ label, prompt }) => ({ label: sanitizeOutput(label), prompt: sanitizeOutput(prompt) }));
}

import { SystemMessage, ToolMessage } from '@langchain/core/messages';

export const FAILURE_NOTE = 'The previous request failed or was interrupted before a final response. Some approved operations may have completed. Verify current files before retrying; do not claim unconfirmed changes succeeded.';

export function createExecutionState() {
    return { cache: new Map(), calls: 0, mutationAttempted: false };
}

function type(message) {
    return message.getType?.() ?? message.type ?? message.role;
}
function size(message) {
    return JSON.stringify({ content: message.content, tool_calls: message.tool_calls }).length;
}

/** Trim whole user turns, keeping tool-call/result pairs intact. No extra model call. */
export function trimConversation(messages, { maxChars = 64000, maxTurns = 12 } = {}) {
    const system = messages.filter((message) => type(message) === 'system');
    const turns = [];
    for (const message of messages.filter((item) => type(item) !== 'system')) {
        if (type(message) === 'human' || type(message) === 'user' || !turns.length) turns.push([]);
        turns.at(-1).push(message);
    }
    const selected = [];
    let length = system.reduce((sum, item) => sum + size(item), 0);
    for (const turn of turns.slice(-maxTurns).reverse()) {
        const bytes = turn.reduce((sum, item) => sum + size(item), 0);
        if (selected.length && length + bytes > maxChars) break;
        selected.unshift(turn);
        length += bytes;
    }
    return [...system, ...selected.flat()];
}

export function recoverConversation(messages, completedTools = [], { fileOperations = [] } = {}) {
    const recovered = [];
    const completed = new Map(completedTools.map((message) => [message.tool_call_id, message]));
    const newest = new Map();
    const consumed = new Set();
    messages.forEach((message, index) => {
        for (const call of message.tool_calls ?? []) newest.set(call.id, index);
    });
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.content === FAILURE_NOTE) continue;
        if (consumed.has(index)) continue;
        recovered.push(message);
        // Tool IDs are scoped to an assistant exchange: some providers reuse
        // them in later turns. Never substitute a previous turn's success.
        const adjacent = new Map();
        for (let next = index + 1; next < messages.length && type(messages[next]) === 'tool'; next++) {
            adjacent.set(messages[next].tool_call_id, { message: messages[next], index: next });
        }
        for (const call of message.tool_calls ?? []) {
            // Providers require each result beside its requesting assistant
            // message, before another assistant/user turn can begin.
            const latest = newest.get(call.id) === index;
            const committed = latest ? fileOperations.filter((operation) => operation.tool_call_id === call.id) : [];
            const confirmed = call.name === 'applyFileOperations' && committed.length
                ? `Confirmed completed file operations before interruption (path data):\n${JSON.stringify(committed)}\nThe remaining operations are unconfirmed; inspect files before any retry.`
                : 'Execution was interrupted. Completion is unconfirmed; inspect files before any retry.';
            const existing = adjacent.get(call.id);
            if (existing) consumed.add(existing.index);
            const result = existing?.message ?? (latest ? completed.get(call.id) : undefined);
            recovered.push(result && !(call.name === 'applyFileOperations' && committed.length && result.status === 'error') ? result : new ToolMessage({
                ...(result ?? {}),
                content: result ? `${result.content}\n${confirmed}` : confirmed,
                tool_call_id: call.id, name: call.name, status: 'error',
            }));
        }
    }
    return [...recovered, new SystemMessage(FAILURE_NOTE)];
}

/** Bound model payloads without changing retained history or losing tool pairs. */
export function prepareModelMessages(messages, { maxChars = 96000 } = {}) {
    const bounded = trimConversation(messages).map((message) => {
        if (type(message) !== 'tool' || typeof message.content !== 'string' || message.content.length <= 12000) return message;
        return new ToolMessage({
            content: `${message.content.slice(0, 12000)}\n[Tool output shortened for context. Request a narrower file range if needed.]`,
            name: message.name, tool_call_id: message.tool_call_id, status: message.status,
        });
    });
    if (bounded.reduce((sum, message) => sum + size(message), 0) > maxChars) {
        throw new Error('Conversation context is too large for this request. Send a smaller task with specific file paths and line ranges.');
    }
    return bounded;
}

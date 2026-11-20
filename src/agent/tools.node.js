import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { sanitizeOutput } from '../ui/terminal.js';
import { createExecutionState } from './conversation.js';
export { createExecutionState } from './conversation.js';

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
}

/** Retain LangGraph's ToolNode validation while serializing and deduplicating calls. */
export function createToolExecutor(tools) {
    const node = new ToolNode(tools);
    return async function executeTools(state, config = {}) {
        const execution = config.configurable?.execution ?? createExecutionState();
        const emit = config.configurable?.onTool ?? (() => {});
        const results = [];
        for (const call of state.messages.at(-1)?.tool_calls ?? []) {
            config.signal?.throwIfAborted();
            const key = `${call.name}:${JSON.stringify(stable(call.args))}`;
            const details = call.args?.path ?? call.args?.directory ?? (call.name === 'applyFileOperations' ? `${call.args?.operations?.length ?? 0} planned changes` : '');
            let result;
            if (execution.cache.has(key)) {
                const previous = execution.cache.get(key);
                result = new ToolMessage({ content: previous.content, status: previous.status, name: call.name, tool_call_id: call.id });
                emit({ name: call.name, status: 'cached', details });
            } else if (++execution.calls > 12 || (call.name === 'applyFileOperations' && execution.mutationAttempted)) {
                result = new ToolMessage({
                    content: 'Stopped repeated tool execution. A mutation batch may run only once per user turn. Report the confirmed results and ask the user before further changes.',
                    status: 'error', name: call.name, tool_call_id: call.id,
                });
                emit({ name: call.name, status: 'blocked', details });
            } else {
                if (call.name === 'applyFileOperations') execution.mutationAttempted = true;
                emit({ name: call.name, status: 'running', details });
                const output = await node.invoke({ messages: [new AIMessage({ content: '', tool_calls: [call] })] }, {
                    ...config,
                    configurable: {
                        ...config.configurable,
                        onFileOperation: (event) => config.configurable?.onFileOperation?.({ ...event, tool_call_id: call.id }),
                    },
                });
                result = output.messages[0];
                // Provider and filesystem errors can contain terminal escapes or credential values.
                if (result.status === 'error') result.content = sanitizeOutput(result.content);
                // Any attempted mutation can change files, including a partial
                // batch. Subsequent reads must observe their current contents.
                if (call.name === 'applyFileOperations') execution.cache.clear();
                execution.cache.set(key, result);
                const failed = result.status === 'error' || /^(?:Cancelled|Batch stopped|Interrupted)/i.test(String(result.content));
                emit({ name: call.name, status: failed ? 'stopped' : 'complete', details });
            }
            results.push(result);
            config.configurable?.onToolResult?.(result);
        }
        return { messages: results };
    };
}

import { MessagesAnnotation, StateGraph, START } from '@langchain/langgraph';
import { toolsCondition } from '@langchain/langgraph/prebuilt';
import { LLMNode } from './model.node.js';
import { applyFileOperationsTool, listDirectoryTool, readFileTool, scanDirectoryTool } from '../tools/files/file.tools.js';
import { createToolExecutor } from './tools.node.js';
import { prepareModelMessages } from './conversation.js';
export { default } from './session.js';

export function createAgentGraph({ modelNode = LLMNode, tools = [applyFileOperationsTool, listDirectoryTool, readFileTool, scanDirectoryTool] } = {}) {
    return new StateGraph(MessagesAnnotation)
        .addNode('LLMNode', async (state, config) => {
            try { return await modelNode({ ...state, messages: prepareModelMessages(state.messages) }, config); }
            finally { config.configurable?.onModelEnd?.(); }
        })
        .addNode('tools', createToolExecutor(tools))
        .addEdge(START, 'LLMNode')
        .addConditionalEdges('LLMNode', toolsCondition)
        .addEdge('tools', 'LLMNode')
        .compile();
}

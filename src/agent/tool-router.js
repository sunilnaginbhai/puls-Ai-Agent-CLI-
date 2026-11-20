const TOOL_ORDER = ["readFile", "listDirectory", "scanDirectory", "applyFileOperations"];

const FILE_CONTEXT = /\b(?:file|files|folder|folders|directory|directories|directry|directries|desktop|documents?|downloads?|pwd|path|code|source|script|module|project|workspace|class|function|readme|dockerfile|makefile|\.\w{1,8})\b|(?:^|\s)(?:\.\.?[\\/]|[\w.-]+[\\/])\S+/i;
const READ_INTENT = /\b(?:read|open|inspect|review|explain|summari[sz]e|debug|analy[sz]e|understand|show)\b/i;
const LIST_INTENT = /\b(?:list|display|show|what(?:'s| is| are))\b[\s\S]{0,60}\b(?:files|folders|directories|contents)\b/i;
const SCAN_INTENT = /\b(?:scan|inventory|enumerate)\b/i;
const MUTATION_INTENT = /\b(?:create|write|edit|modify|update|change|replace|move|rename|save|generate|implement|add|build|fix|refactor)\b/i;
const CODE_CHANGE_INTENT = /\b(?:edit|modify|update|change|replace|implement|refactor|fix)\b/i;
const CONTINUATION = /^(?:yes\b|yep\b|okay\b|ok\b|continue\b|go ahead\b|do (?:it|that)\b|proceed\b|try again\b|retry\b)/i;

function contentToText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
        .map((part) => typeof part === "string" ? part : (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
}

function isHumanMessage(message) {
    const type = typeof message?.getType === "function" ? message.getType() : message?.type;
    return type === "human" || type === "user" || message?.role === "user";
}

/** Find the most recent user message, skipping assistant and tool messages. */
export function getLatestUserMessageText(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (isHumanMessage(messages[index])) {
            return contentToText(messages[index].content);
        }
    }
    return "";
}

/** Keep a short follow-up attached to its preceding task without another API call. */
export function getRoutingMessageText(messages = []) {
    const humanTexts = messages.filter(isHumanMessage).map((message) => contentToText(message.content));
    let index = humanTexts.length - 1;
    if (index < 0) return "";
    const parts = [humanTexts[index]];
    while (index > 0 && CONTINUATION.test(humanTexts[index].trim())) {
        index -= 1;
        parts.unshift(humanTexts[index]);
    }
    return parts.join("\n");
}

/** Select only file tools relevant to the latest user request. */
export function selectToolsForMessage(messageText = "") {
    const text = String(messageText);
    const selected = new Set();
    const hasFileContext = FILE_CONTEXT.test(text);

    if (hasFileContext && READ_INTENT.test(text)) selected.add("readFile");
    if (LIST_INTENT.test(text)) selected.add("listDirectory");
    if (SCAN_INTENT.test(text) && hasFileContext) selected.add("scanDirectory");

    if (MUTATION_INTENT.test(text) && hasFileContext) {
        selected.add("applyFileOperations");
        // Inspect relevant existing code before edits when the request changes code.
        if (CODE_CHANGE_INTENT.test(text)) selected.add("readFile");
    }

    return TOOL_ORDER.filter((name) => selected.has(name));
}

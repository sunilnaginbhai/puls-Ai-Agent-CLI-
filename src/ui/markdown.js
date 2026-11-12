import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(
    markedTerminal({
        width: Math.min(process.stdout.columns || 80, 100),
        reflowText: true,
        showSectionPrefix: false,
    })
);

function contentToMarkdown(content) {
    if (typeof content === "string") return content;

    // LangChain can also return text as content blocks.
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === "string") return block;
                return typeof block?.text === "string" ? block.text : "";
            })
            .filter(Boolean)
            .join("\n");
    }

    return content == null ? "" : JSON.stringify(content, null, 2);
}

export function formatAssistantResponse(content) {
    const markdown = contentToMarkdown(content);
    const rendered = marked.parse(markdown);
    return typeof rendered === "string" ? rendered.trimEnd() : String(rendered);
}
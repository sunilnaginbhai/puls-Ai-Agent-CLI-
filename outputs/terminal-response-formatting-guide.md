# Format Puls AI responses clearly in the terminal

The screenshot shows Markdown being printed as plain text. In `src/graph/graph.js`, the CLI currently passes `latestMessage.content` directly to `console.log`, so headings, bold text, fenced code, and tables are not rendered. Add a terminal Markdown renderer at the output boundary. The current `marked-terminal` package renders headings, code blocks, and tables; its latest release requires Node 22.12 or later. Your project is running Node 24.19, so it meets that requirement. [1]

## 1. Install the renderer

From the Puls AI project folder, run:

```powershell
npm install marked marked-terminal
```

`marked-terminal` plugs into Marked with `marked.use(...)`. Register the extension once when the helper module loads, rather than inside the conversation loop. [1] [2]

## 2. Add `src/utils/markdown.js`

```js
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
```

## 3. Replace the raw print in `src/graph/graph.js`

Add this import with the other imports at the top:

```js
import { formatAssistantResponse } from "../utils/markdown.js";
```

Then replace the block around the existing `latestMessage` check (currently around lines 93–97):

```js
const latestMessage = messages.at(-1);
if (latestMessage && typeof latestMessage.content === "string") {
  console.log("\n[AI]:", latestMessage.content);
} else {
  console.log("\n[AI]: I processed that request.");
}
```

with:

```js
const latestMessage = messages.at(-1);
if (latestMessage?.content != null) {
  process.stdout.write("\n[AI]:\n");
  process.stdout.write(`${formatAssistantResponse(latestMessage.content)}\n\n`);
} else {
  console.log("\n[AI]: I processed that request.\n");
}
```

This is the key change: render only the assistant's final response, not the raw Markdown source. `marked-terminal` wraps text and tables to the terminal width and disables colors when output is not an interactive terminal or `NO_COLOR` is set. [1]

## 4. Ask the model for terminal-friendly answers

In the existing `SystemMessage` in `src/graph/graph.js`, add these style rules to the current instructions:

```text
- Start with a direct, concise answer.
- Use headings only for longer or multi-step answers.
- Use numbered steps for procedures and bullets for options.
- Put commands and code in fenced code blocks with a language label.
- Prefer bullets over wide Markdown tables because terminal windows may be narrow.
- Separate errors from advice: state the error, likely cause, and next action.
- Do not claim a fix succeeded unless a tool or check verified it.
```

A renderer changes presentation; these prompt rules encourage the model to produce a more useful structure. They do not guarantee factual accuracy.

## 5. Keep Puls AI errors separate from assistant Markdown

Your `catch` block in `src/graph/graph.js` currently prints `error.message` directly. That is for failures in Puls AI itself. Format those as a separate error block, and show stack traces only in debug mode:

```js
} catch (error) {
  failSpinner("Request failed");
  const message = String(error?.message ?? error);

  console.error("\n[Error]");
  if (/ECONNREFUSED/i.test(message)) {
    console.error("Could not connect to the configured local service.");
    console.error("Check that it is running and that the host and port are correct.");
  } else {
    console.error(message);
  }

  if (process.env.PULS_AI_DEBUG === "1" && error?.stack) {
    console.error(error.stack);
  }
}
```

The screenshot's `ECONNREFUSED 127.0.0.1:18789` text appears in the conversation content. Rendering can make that explanation readable, but it cannot make the endpoint available or verify the diagnosis. If that refusal is from a service you are trying to connect to, separately check that the service is running and listening on the exact host and port.

## 6. Test it

Run `npm start` and ask for a multi-step answer containing a heading, bullets, a command, and a table. Confirm the terminal shows formatted headings and code rather than literal `##`, `**`, or triple backticks. Also test a short plain-text response and a non-TTY output such as redirecting output to a file. Formatting should not alter the message stored in graph history.

## References

[1]: https://www.npmjs.com/package/marked-terminal "marked-terminal package documentation"
[2]: https://marked.js.org/using_pro "Marked extension documentation"

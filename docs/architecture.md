# Puls AI architecture

Puls AI is a Node.js ESM CLI. The existing LangGraph message graph coordinates the model and workspace tools; separate modules own terminal presentation, input, authentication, and local settings. The compatibility launcher `cli.js` and published `bin/puls-ai.js` both call `src/app/main.js`.

## Component responsibilities

| Module | Responsibility |
| --- | --- |
| `src/app/main.js` | Flags, workspace validation, startup, deferred key setup, and process cleanup |
| `src/agent/agent.graph.js` | Graph construction and compatibility session export |
| `src/agent/session.js` | Command loop, deferred graph loading, streamed state, and per-turn cancellation |
| `src/agent/model.node.js` | Selected tool binding, provider stream aggregation, token callback, and request deadline |
| `src/agent/tool-router.js` | Local intent matching, including short continuations of preceding user requests |
| `src/agent/tools.node.js` | Sequential LangGraph ToolNode calls, per-turn deduplication, execution limits, and activity events |
| `src/agent/conversation.js` | Whole-turn context trimming and interrupted tool-result recovery |
| `src/providers/` | Provider metadata, credential selection, and lazy model SDK construction |
| `src/config/` | Configuration paths, provider key storage, and serialized settings writes |
| `src/tools/files/file.tools.js` | Bounded reads/scans and validated, approved file-operation batches |
| `src/security/permission.prompt.js` | Queued explicit-consent prompts and denial in non-interactive sessions |
| `src/ui/readline.js` | Lazy shared input owner, piping, completion, multiline input, history, and cancellation events |
| `src/ui/terminal.js` | Welcome, status, help, tool summaries, errors, width adaptation, and color policy |
| `src/ui/markdown.js` | Markdown rendering and buffered progressive response output |
| `src/ui/sanitize.js` | Terminal-control removal and credential redaction for displayed output |
| `src/ui/spinner.js` | A shared loading indicator with pause/resume around prompts |
| `scripts/test-environment.js` | Pre-import test profile isolation, credential removal, and tracing suppression |

## Startup and input

`--help` and `--version` return before loading the graph or requesting credentials. `--no-color` follows the same color policy as `NO_COLOR`. Startup validates the configured workspace, shows session metadata in a TTY, and enters the command loop. `/help`, `/status`, `/clear`, and `/bye` are handled locally. An unknown slash command never becomes an AI request.

The shared `TerminalInput` creates readline lazily. Piped lines are queued so input arriving while a model runs is available to subsequent turns. Interactive input uses readline's completion and cursor handling, keeps normal typing from repainting an active response, and emits cancellation independently of pending questions. Lines pasted together are retained while a logical request is being collected. A trailing single backslash continues a logical request onto another line; a final line without it submits the request. A doubled trailing backslash remains literal. EOF submits already collected continuation text in a piped session.

Queued input is bounded to 1 MiB or 1,024 lines. A byte-counting guard limits individual piped lines before readline can accumulate an unbounded newline-free stream; logical multiline accumulation is also capped at 1 MiB. Exceeding a bound raises `ERR_INPUT_LIMIT` and closes input without echoing its contents. Stream errors reject waiting prompts cleanly. Cancellation is checked again after asynchronous initialization, before a queued line can be consumed.

Only logical request collection may consume queued interactive lines. Direct approval and credential questions require fresh input and clear the native partial line, so pasted commands cannot become consent. A cancelled secret entry is cleared before output is unmasked, and its earlier in-memory history is restored.

Recognized slash commands persist in `.puls-ai/history.json`; ordinary requests and keys do not. Input history and conversation state otherwise remain in memory. Ctrl+C aborts an active turn, including permission prompts. While idle it clears input; a second quick press requests exit. Shutdown removes process listeners, closes input, waits for pending history persistence, and stops the spinner.

## Model and graph execution

The graph retains `START -> LLMNode -> tools -> LLMNode`, with LangGraph's `toolsCondition` selecting the final exit. `createAgentGraph` accepts injected nodes and tools for regression tests. Each user turn supplies its own `AbortSignal`, tool-execution state, provider configuration, and presentation callbacks through Runnable config.

`LLMNode` finds the latest user intent and binds only relevant tools. General questions receive no filesystem tools. The router is local and adds no model request or API tokens; recognized short follow-ups inherit the preceding task's routing context. Mutation turns have a 4,096-token output ceiling; ordinary turns retain the 1,024-token ceiling. The provider factory loads only the chosen Groq, OpenAI, or Google SDK. A request deadline covers credential resolution, asynchronous SDK initialization, opening a stream, and consuming it; provider SDK retries are bounded.

The completed response is validated before it becomes an executable graph message. LangChain's permissive parsing of partial JSON is insufficient for this boundary: final streamed tool arguments must parse as complete JSON objects, and invalid tool calls are rejected. A finish reason indicating the model's output limit raises `MODEL_OUTPUT_TRUNCATED`; no tool from that incomplete response executes.

Model chunks are aggregated into a LangChain AI message while text is sent to a presentation callback. Graph `values` streaming preserves each committed state as it arrives. Tool activity ends pending response rendering before displaying a tool event, avoiding interleaved spinner or approval output. Presentation callbacks never replace the model's original messages with rendered Markdown.

The tool executor invokes one call at a time through the existing LangGraph `ToolNode`, retaining its schema validation and tool-result handling. A canonical name-and-arguments key caches results within the current user turn; repeated identical calls receive a new matching tool-result ID without rerunning the operation. Mutation attempts invalidate earlier cached reads so verification sees current files. Each turn allows at most 12 fresh tool attempts and one mutation batch. A graph recursion limit provides a separate bound on model/tool loops.

Conversation trimming keeps complete recent user turns and their associated tool-call/result pairs, targeting 12 turns and approximately 64,000 serialized characters while retaining the latest turn. Model payloads shorten individual tool results to 12,000 characters without changing retained history and reject payloads above 96,000 characters with a recovery instruction. User requests are limited to 32,000 characters. After interruption or failure, recovery places results beside their requesting assistant message, before the next user or assistant turn, and adds a note warning that file changes may have partially completed.

Committed filesystem operations emit host-side progress events. The tool executor attaches the current tool-call ID, and the session retains those events separately from the graph's committed state. Recovery can therefore associate confirmed per-file changes with the correct mutation call even when cancellation prevents the batch's final result from entering the graph. Completed tool results remain authoritative; unconfirmed operations still require inspection before a retry.

## Authentication and settings

`PULS_PROVIDER` selects `groq`, `openai`, or `google`; `PULS_MODEL` overrides the provider default. Provider-specific environment keys precede the compatible `PULS_API_KEY` fallback, session cache, and stored settings. Model setup is deferred until an AI request, so local commands work without keys. Interactive entry is hidden. Groq keys are validated once in the session; other SDKs authenticate with their first model request.

Settings live in `<PULS_HOME or user home>/.puls-ai/settings.json`. The existing top-level Groq `apiKey` entry remains supported; other providers use separate entries. Save operations are serialized and replace settings through a temporary file. Existing unrelated settings are retained, and malformed JSON produces an actionable error instead of an overwrite. Keys are stored as local plaintext; owner-only creation permissions are requested where supported. Secrets are never included in session metadata.

## Filesystem boundaries and approval

The workspace defaults to the launch directory and can be overridden by `PULS_AI_WORKSPACE`. Path validation checks containment, existing ancestors, symbolic links and junctions, terminal controls, and Windows device names, alternate data streams, and trailing-dot/space aliases. Replacement of a file with multiple hard links is rejected.

`readFile` supports numbered ranges of up to 400 lines and 48 KiB of returned text, scanning at most 256 KiB or 20,000 lines. It blocks common credential paths, Puls's own credential store, and non-regular files. Empty files have an explicit result, and opening errors reject the tool call rather than leaking an unhandled read-stream error. Reads propagate the turn's abort signal into the stream and check it during consumption.

Directory tools use `fs.opendir` iterators instead of materializing every directory entry. They return at most 200 entries, exclude recursive traversal through symlinks, report truncation, and check cancellation while enumerating. Iterator cleanup closes directory handles on completion, cancellation, or an early limit. Recursive scanning also has a depth limit and skips common generated directories.

`applyFileOperations` is the only model-exposed mutation tool. Its schema supports create/replace file, create directory, and move file operations, with at most 25 operations per batch. Individual unreviewed mutation tools are not exposed. Preparation validates the whole plan, including duplicate move sources and conflicting parent/child file targets. Text changes show a bounded unified-style preview; credential contents are omitted and binary changes are labeled.

The permission module serializes prompts and defaults to denial. Non-interactive input always declines mutations, so a piped `y` cannot approve a batch. Interactive approval also cannot consume text queued by an earlier paste. Host Runnable config can inject an approval function for isolated tests; model tool arguments cannot select that function. Cancellation is checked before mutations and between operations.

Approved operations execute sequentially. Existing-file identity and content digests are checked against the preview, and paths are validated again before execution. Creates use exclusive writes. Replacements stage the complete content in an exclusively created temporary file in the target directory, preserve POSIX ownership and permissions where supported, flush the staged file, recheck the approved original and paths, then rename the staging file over the original. A staging or rename failure leaves the approved original intact and cleans up the owned temporary file. On Windows, the new file inherits directory ACLs; custom per-file ACLs on the original are not preserved by this mechanism.

Moves use exclusive copy, verify the copied and source contents, then remove the source. If a source changes during copying, both paths are retained. Each committed mutation emits a progress event independently of the final batch response. On an error, the result lists completed operations and leaves remaining operations unattempted. Batches do not implement rollback; atomic replacement of one file does not make the whole batch transactional.

These checks protect ordinary CLI use and concurrent-edit mistakes; they do not create an operating-system sandbox or eliminate races against a malicious process swapping paths at the exact instant of a filesystem call.

## Rendering and sensitive output

Terminal colors depend on TTY support, `NO_COLOR`, `NODE_DISABLE_COLORS`, and the terminal type. Piped output avoids animated spinners and clear-screen escapes. Metadata wraps at the current width using grapheme boundaries. Markdown uses the existing `marked` and `marked-terminal` dependencies, with language labels on code blocks and plain output when colors are disabled.

The response writer flushes complete Markdown blocks and progressively releases long prose. Code fences wait until closed, within the model's output-token bound. This avoids cursor rewrites and repeated rendering of already printed text. Short incomplete paragraphs can wait until a block boundary or the end of the stream. Text with complex Unicode graphemes uses native terminal wrapping to avoid splitting surrogate pairs or composed characters.

All displayed provider, tool, and workspace strings are treated as untrusted terminal text. Sanitization removes terminal control sequences and redacts recognized credential formats, named secret assignments, private-key blocks, known secret environment values, and explicitly registered active provider keys. It also applies to error details and optional debug traces. Redaction is defense in depth; unrelated source files can still contain secrets that do not match known formats, so users should keep sensitive material outside the active workspace.

## Development checks and limits

Run `npm ci`, `npm test`, and `npm run check`. The test command preloads `scripts/test-environment.js` before test or application imports. The preload creates a disposable `PULS_HOME` and workspace, removes inherited provider credentials, and disables LangChain/LangSmith tracing. This protects the real profile even if a test imports settings eagerly. Direct `node --test` bypasses the preload; use `npm test`, including for focused runs such as `npm test -- tests/unit/terminal-input.test.js`.

The regression suite uses temporary workspaces and injected model streams/approval functions for filesystem plans and execution, cancellation, routing, provider errors, settings, and terminal rendering. Integration tests additionally exercise the actual OpenAI SDK against an explicitly configured loopback HTTP server using a dummy key. They cover SSE streaming, fragmented tool arguments, incomplete JSON rejection, rate limits, cancellation, deadlines, and transport failures without contacting a live model provider. The POSIX permission-preservation test is skipped on Windows.

The check script validates JavaScript syntax. Start with `npm start` or `npm run dev`. There are no separate style-lint or build scripts.

Live provider access, billing permissions, and account-specific model availability need a credentialed smoke test. Tests of widths and streams do not verify every real terminal, font, or shell. The router uses intent matching rather than semantic planning, context retention uses trimming rather than model summarization, and a partially completed mutation batch must be reviewed before retrying. Do not commit credentials, local settings, `node_modules`, or generated build output.

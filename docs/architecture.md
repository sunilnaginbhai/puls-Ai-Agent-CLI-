# Puls AI architecture

Puls AI is a Node.js ESM CLI. The existing LangGraph message graph coordinates the model and workspace tools; separate modules own terminal presentation, input, authentication, and local settings. The compatibility launcher `cli.js` and published `bin/puls-ai.js` both call `src/app/main.js`.

## Component responsibilities

| Module | Responsibility |
| --- | --- |
| `src/app/main.js` | Flags, workspace validation, startup, provider onboarding, and process cleanup |
| `src/agent/agent.graph.js` | Graph construction and compatibility session export |
| `src/agent/session.js` | Command loop, deferred graph loading, streamed state, and per-turn cancellation |
| `src/agent/model.node.js` | Selected tool binding, provider stream aggregation, token callback, and request deadline |
| `src/agent/tool-router.js` | Local intent matching, including short continuations of preceding user requests |
| `src/agent/tools.node.js` | Sequential LangGraph ToolNode calls, per-turn deduplication, execution limits, and activity events |
| `src/agent/conversation.js` | Whole-turn context trimming and interrupted tool-result recovery |
| `src/agent/followups.js` | Local contextual follow-up prompts after successful responses |
| `src/providers/` | Provider metadata, credential selection, and lazy model SDK construction |
| `src/config/` | Configuration paths, provider key storage, and serialized settings writes |
| `src/tools/files/file.tools.js` | Bounded reads/scans and validated, approved file-operation batches |
| `src/security/permission.prompt.js` | Queued explicit-consent prompts and denial in non-interactive sessions |
| `src/ui/readline.js` | Lazy shared input owner, piping, completion, multiline input, history, and cancellation events |
| `src/ui/commands.js` | Shared command definitions, argument parsing, prompt shortcuts, and command matching |
| `src/ui/command-menu.js` | Transient slash-command palette layout, selection display, and cursor restoration |
| `src/ui/terminal.js` | Welcome, status, help, tool summaries, errors, width adaptation, and color policy |
| `src/ui/markdown.js` | Markdown rendering and buffered progressive response output |
| `src/ui/sanitize.js` | Terminal-control removal and credential redaction for displayed output |
| `src/ui/spinner.js` | A shared loading indicator with pause/resume around prompts |
| `scripts/test-environment.js` | Pre-import test profile isolation, credential removal, and tracing suppression |

## Startup and input

`--help` and `--version` return before loading the graph or requesting credentials. `--no-color` follows the same color policy as `NO_COLOR`. Startup validates the configured workspace, shows session metadata in a TTY, and enters the command loop. `/help`, `/status`, `/model`, `/workspace`, `/history`, `/new`, `/followups`, `/clear`, and `/bye` are handled locally without model setup. An unknown slash command never becomes an AI request.

The shared command catalog defines 20 commands and supplies the palette, completion, help, routing, and history. AI prompt shortcuts are `/explain`, `/review`, `/fix`, `/test`, `/plan`, `/refactor`, `/summarize`, and `/continue`. Required arguments are validated before a model request. `/continue` requires a successful preceding turn and retains that turn's tool policy. `/new` resets conversation messages, turn count, follow-up suggestions, and pending drafts.

Typing `/` in the main interactive request prompt opens the command palette immediately. Prefix matching filters its descriptions as the user types. Up/Down moves the highlight; Enter chooses; Tab fills without submission; Esc dismisses the palette while retaining input. Enter on a command requiring arguments fills its name and a trailing space, allowing the user to provide the target. Palette rows adapt to terminal dimensions and preserve readline's cursor. The palette stays out of secret entry, direct approval questions, busy output, pipes, and dumb terminals.

The shared `TerminalInput` creates readline lazily. Piped lines are queued so input arriving while a model runs is available to subsequent turns. Interactive input uses readline's completion and cursor handling, keeps normal typing from repainting an active response, and emits cancellation independently of pending questions. Lines pasted together are retained while a logical request is being collected. A trailing single backslash continues a logical request onto another line; a final line without it submits the request. A doubled trailing backslash remains literal. EOF submits already collected continuation text in a piped session.

Queued input is bounded to 1 MiB or 1,024 lines. A byte-counting guard limits individual piped lines before readline can accumulate an unbounded newline-free stream; logical multiline accumulation is also capped at 1 MiB. Exceeding a bound raises `ERR_INPUT_LIMIT` and closes input without echoing its contents. Stream errors reject waiting prompts cleanly. Cancellation is checked again after asynchronous initialization, before a queued line can be consumed.

Only logical request collection may consume queued interactive lines. Direct approval and credential questions require fresh input and clear the native partial line, so pasted commands cannot become consent. A cancelled secret entry is cleared before output is unmasked, and its earlier in-memory history is restored.

Recognized slash-command names persist in `.puls-ai/history.json`; their arguments, ordinary requests, and keys do not. Input history and conversation state otherwise remain in memory. Ctrl+C aborts an active turn, including permission prompts. While idle it clears input; a second quick press requests exit. Shutdown removes process listeners, closes input, waits for pending history persistence, and stops the spinner.

## Model and graph execution

The graph retains `START -> LLMNode -> tools -> LLMNode`, with LangGraph's `toolsCondition` selecting the final exit. `createAgentGraph` accepts injected nodes and tools for regression tests. Each user turn supplies its own `AbortSignal`, tool-execution state, provider configuration, and presentation callbacks through Runnable config.

`LLMNode` finds the latest user intent and binds only relevant tools. General questions receive no filesystem tools. The router is local and adds no model request or API tokens; recognized short follow-ups inherit the preceding task's routing context. Mutation turns have a 4,096-token output ceiling; ordinary turns retain the 1,024-token ceiling. The provider factory loads only the chosen Groq, OpenAI, or Google SDK. A request deadline covers credential resolution, asynchronous SDK initialization, opening a stream, and consuming it; provider SDK retries are bounded.

The `/explain`, `/review`, `/plan`, and `/summarize` shortcuts set a read-only tool policy. Both model binding and the tool executor enforce it, so a model-requested mutation cannot cross the execution boundary during those commands. `/fix`, `/test`, and `/refactor` retain the normal reviewed file-operation flow. The test shortcut supports inspecting or creating test files; the tool catalog currently provides no shell runner, so suggested commands and actual test execution remain distinct.

The completed response is validated before it becomes an executable graph message. LangChain's permissive parsing of partial JSON is insufficient for this boundary: final streamed tool arguments must parse as complete JSON objects, and invalid tool calls are rejected. A finish reason indicating the model's output limit raises `MODEL_OUTPUT_TRUNCATED`; no tool from that incomplete response executes.

Model chunks are aggregated into a LangChain AI message while text is sent to a presentation callback. Graph `values` streaming preserves each committed state as it arrives. Tool activity ends pending response rendering before displaying a tool event, avoiding interleaved spinner or approval output. Presentation callbacks never replace the model's original messages with rendered Markdown.

The tool executor invokes one call at a time through the existing LangGraph `ToolNode`, retaining its schema validation and tool-result handling. A canonical name-and-arguments key caches results within the current user turn; repeated identical calls receive a new matching tool-result ID without rerunning the operation. Mutation attempts invalidate earlier cached reads so verification sees current files. Each turn allows at most 12 fresh tool attempts and one mutation batch. A graph recursion limit provides a separate bound on model/tool loops.

Conversation trimming keeps complete recent user turns and their associated tool-call/result pairs, targeting 12 turns and approximately 64,000 serialized characters while retaining the latest turn. Model payloads shorten individual tool results to 12,000 characters without changing retained history and reject payloads above 96,000 characters with a recovery instruction. User requests are limited to 32,000 characters. After interruption or failure, recovery places results beside their requesting assistant message, before the next user or assistant turn, and adds a note warning that file changes may have partially completed.

Committed filesystem operations emit host-side progress events. The tool executor attaches the current tool-call ID, and the session retains those events separately from the graph's committed state. Recovery can therefore associate confirmed per-file changes with the correct mutation call even when cancellation prevents the batch's final result from entering the graph. Completed tool results remain authoritative; unconfirmed operations still require inspection before a retry.

After a successful interactive response, `suggestFollowups` returns three curated `{label, prompt}` descriptors based on the request, final answer, tools used, and confirmed file operations. It makes no provider request and copies no arbitrary source text, credentials, or filenames into the suggested prompts. An attempted or declined mutation is not treated as a confirmed change. Failed or cancelled turns do not produce a new follow-up footer.

The session retains these suggestions and adds `/1`, `/2`, and `/3` to the interactive palette. Selecting one creates a one-shot editable draft for the next main request prompt; the user must press Enter to submit it. `/followups` reprints the current options. Piped responses omit the automatic footer, and explicit numbered follow-up commands print their prompt for separate submission instead of executing it or consuming another queued line. Drafts are used only by normal request collection, preserving the requirement for fresh approval and credential input.

## Authentication and settings

`PULS_PROVIDER` selects `groq`, `openai`, `google`, `openrouter`, or `freellmapi`; `PULS_MODEL` overrides the provider default. OpenRouter uses the OpenAI-compatible API endpoint and defaults to `openrouter/free`, a router for available free models. FreeLLMAPI uses `https://api.freellmapi.com/v1` and defaults to its `auto` model router. Provider-specific environment keys precede the compatible `PULS_API_KEY` fallback, session cache, and stored settings. Interactive startup restores `activeProvider` or uses `PULS_PROVIDER`. If credentials are missing, `src/providers/onboarding.js` asks for a provider and its hidden key before displaying the chat prompt. The selected provider is persisted with the key. Help/version flags bypass setup; piped sessions retain deferred authentication. Interactive entry is hidden. Groq keys are validated once in the session; other SDKs authenticate with their first model request.

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

## Logout

Use `/logout` to remove the local `.puls-ai` profile, including all saved provider API keys, settings, and command history, and exit the session. The CLI requires fresh interactive yes/no confirmation; an empty answer, no, or Ctrl+C cancels. Piped input cannot confirm deletion. Pending history saves finish before deletion so they cannot recreate the profile. Workspace files are preserved. Keys exported in the parent shell remain there and must be unset separately if desired; local logout does not revoke provider-side API keys.

## Telegram integration

`src/integrations/telegram/` separates the Bot API HTTP client, encrypted token vault, interactive settings, and polling lifecycle. `main.js` owns startup/shutdown and optional onboarding; `session.js` routes `/telegram` and `/settings telegram`, displays status, and stops polling before logout deletion. Optional setup failure leaves local chat usable. No integration is started or network request made after Skip. Persisted settings and update offsets use the same serialized atomic `updateSettings` helper as provider credentials.

The runtime accepts private messages only after numeric sender-ID authorization. It retains separate bounded in-memory conversations and calls the existing compiled graph, context trimming, error recovery, model factory, and tool executor. The read-only policy is enforced by both model tool binding and execution; remote messages never consume terminal approval prompts. Responses are redacted and split below Telegram's message size limit. No bot tokens or model credentials are placed in context. Retry delays are abortable, polling is sequential, acknowledged offsets prevent duplicate executions, and stop cancels active graph requests before clearing memory. The runtime never writes unsolicited output over the terminal input prompt; status is available through local commands.

Windows tokens use native CurrentUser DPAPI through a hidden PowerShell subprocess with token bytes sent on stdin, never command arguments. POSIX tokens use authenticated AES encryption plus a mode-0600 local key. This protects stored token content but is not a hardware-backed or OS-keychain solution on POSIX. Session context is not persisted, and remote writes are intentionally unavailable. Tests cover skipped setup, invalid token/access configuration, encryption roundtrip/tampering, authorization, commands, per-user context/reset, reconnects, deduplication, graceful abort, and real loopback HTTP transport without a live Telegram account.

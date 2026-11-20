# Puls AI CLI

Puls AI is a local-first coding assistant with a LangGraph agent, streamed terminal responses, and approval-based workspace file tools. It supports Groq, OpenAI, Google, OpenRouter, and FreeLLMAPI model providers.

## Install and run

Requires Node.js 22.12 or later. Install the locked dependencies and start the CLI:

```powershell
npm ci
npm start
```

The installed command is `puls-ai`. The compatibility launcher `node cli.js` remains supported. Use `npm run dev` for automatic restarts during development.

```powershell
node cli.js --help
node cli.js --version
node cli.js --no-color
```

Help and version flags work without an API key. On a new interactive profile, Puls asks you to choose Groq, Google Gemini, OpenAI, OpenRouter (which offers free models), or FreeLLMAPI (a free-model router), then asks for that provider's API key with hidden entry. Setup finishes before the chat prompt appears. The provider selection is saved with the key and restored on the next launch; `PULS_PROVIDER` overrides it. Piped sessions keep non-interactive credential handling.

## Providers and configuration

| Provider | `PULS_PROVIDER` | Default model | API-key variable |
| --- | --- | --- | --- |
| Groq | `groq` (default) | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| OpenAI | `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` |
| Google | `google` | `gemini-2.5-flash` | `GOOGLE_API_KEY` |
| OpenRouter | `openrouter` | `openrouter/free` | `OPENROUTER_API_KEY` |
| FreeLLMAPI | `freellmapi` | `auto` | `FREELLMAPI_API_KEY` |

Set a provider-specific key, use the existing `PULS_API_KEY` fallback, or enter a key at the interactive prompt. Provider-specific environment keys take precedence. Keys entered through the prompt are saved to the local settings file; environment keys are not saved. Groq keys are validated once per session; other providers authenticate through their first model request.

OpenRouter's `openrouter/free` model routes requests to an available free model. Free model availability, rate limits, and tool support depend on OpenRouter and its currently available models; create an OpenRouter account and API key to use it. Set `PULS_MODEL` if you want to select a specific OpenRouter model instead.

FreeLLMAPI uses the OpenAI-compatible endpoint `https://api.freellmapi.com/v1` and its `auto` model router. Create a FreeLLMAPI key and set `FREELLMAPI_API_KEY`; routing and model availability depend on the service's current catalog and limits. Set `PULS_MODEL` to use another supported FreeLLMAPI model or routing strategy.

Example in PowerShell:

```powershell
$env:PULS_PROVIDER = "openai"
$env:OPENAI_API_KEY = "your-api-key"
$env:PULS_AI_WORKSPACE = "C:\path\to\your\project"
node cli.js
```

To use OpenRouter's free-model routing, set `$env:PULS_PROVIDER = "openrouter"` and `$env:OPENROUTER_API_KEY = "your-openrouter-api-key"` instead.

To use FreeLLMAPI, set `$env:PULS_PROVIDER = "freellmapi"` and `$env:FREELLMAPI_API_KEY = "your-freellmapi-api-key"`.

For macOS/Linux shells, use `export NAME="value"` for the same environment variables.

| Variable | Purpose |
| --- | --- |
| `PULS_AI_WORKSPACE` | Workspace root; defaults to the launch directory |
| `PULS_MODEL` | Override the selected provider's default model identifier |
| `PULS_REQUEST_TIMEOUT_MS` | Model request deadline, 1,000–600,000 ms; default 120,000 |
| `PULS_HOME` | Parent directory for `.puls-ai`; defaults to the user's home directory |
| `NO_COLOR` | Disable colors when present; also available as `--no-color` |
| `PULS_AI_DEBUG=1` | Include sanitized stack traces in error output |
| `PULS_SKIP_API_KEY_VALIDATION=1` | Skip the Groq key-validation request for offline test setups; model requests still authenticate |

Settings live in `<home>/.puls-ai/settings.json`, with provider-specific entries and compatibility for the existing Groq `apiKey` entry. The CLI preserves malformed settings rather than overwriting them. Keys are local plaintext settings; file creation requests owner-only permissions where the operating system supports them. Keep the settings directory and environment files out of source control.

## Commands and input

Type `/` in an interactive request prompt to open suggestions immediately. The menu contains 20 commands with descriptions; keep typing to filter it, for example `/re` for `/review` and `/refactor`. It adapts to terminal width and height and scrolls through longer lists.

| Command | Action |
| --- | --- |
| `/help` | List commands and keyboard shortcuts |
| `/status` | Show model, provider, workspace, agent state, and completed turns |
| `/model` | Show the active provider and model |
| `/workspace` | Show the current workspace path |
| `/history` | Show recent slash-command names |
| `/new` | Start a fresh conversation and clear pending follow-up suggestions and drafts |
| `/followups` | Show the three suggested next steps for the last successful response |
| `/explain <file or topic>` | Explain code or a concept using read-only tools |
| `/review <file or task>` | Review code for bugs and edge cases using read-only tools |
| `/fix <bug or file>` | Investigate and propose a correction; file changes require approval |
| `/test <file or behavior>` | Inspect coverage or add regression-test files with approval |
| `/plan <task>` | Produce an implementation plan using read-only tools |
| `/refactor <file or goal>` | Refactor code while preserving behavior; file changes require approval |
| `/summarize <file or topic>` | Summarize code, a topic, or the conversation using read-only tools |
| `/continue` | Continue after a successful response, retaining the preceding command's tool policy |
| `/clear` | Clear an interactive terminal |
| `/logout` | Ask yes/no, delete all saved Puls keys/settings/history, clear the session, and exit |
| `/bye` | Exit and clean up terminal input |

`/help`, `/status`, `/model`, `/workspace`, `/history`, `/new`, `/followups`, `/clear`, and `/bye` run locally. Unknown slash commands show a suggestion and do not call the model. The `/test` shortcut can inspect or create test files; it clearly distinguishes those actions from executing tests, since the CLI currently has no shell-execution tool.

- **Up / Down:** select a suggestion while the slash menu is open; otherwise navigate input history.
- **Enter:** choose a command. A command that needs arguments fills its name and waits for you to enter the target before submission.
- **Tab:** fill the selected command without submitting it.
- **Esc:** close the suggestions and keep the current input.
- **Multiline:** end a line with a single `\` to continue onto the next line. Submit a final line without the trailing `\`, or an empty line, to send the request. A doubled trailing `\\` is literal.
- **Ctrl+C:** cancel an active request or clear the current input. Press again while idle to exit.
- **Ctrl+D:** exit when the input is empty.

Only recognized slash-command names persist in `.puls-ai/history.json`; command arguments, ordinary requests, and credential input are not written to that history file. Conversation context remains in memory for the current session. The command catalog is shared by suggestions, completion, help, routing, and history.

Pasted multiline input is retained across continuation prompts. Approval and credential prompts require fresh input: queued pasted commands cannot answer them. Cancelling a partly entered key clears it before terminal echo resumes.

## Responses and file changes

The welcome screen shows the active model, workspace, and session state. Assistant responses render Markdown, tables, lists, and language-labeled code blocks. Complete Markdown blocks appear progressively; fenced code is buffered until it closes so highlighting remains stable. Tool activity identifies the file or directory being accessed. Layouts use the current terminal width, colors are disabled for pipes, and loading indicators stay out of non-interactive output.

After a successful interactive AI response, three contextual follow-up suggestions appear. They can offer examples, a review, a test plan, or other next steps based on the completed turn. Choose `/1`, `/2`, or `/3` to place the corresponding prompt in the input, edit it if needed, then press Enter to send. `/followups` shows the suggestions again. Generating suggestions uses local rules and adds no model request. Choosing a suggestion only drafts a prompt; it does not automatically execute the suggested task.

Filesystem tools are restricted to the configured workspace. Reads return numbered ranges with limits on lines, output bytes, and scanned bytes. Common credential files, including Puls's own settings, and symbolic-link paths are blocked. Directory listing and scanning return at most 200 entries and indicate truncation. Directory enumeration uses bounded iterators, and reads, listings, and scans honor cancellation.

All model file mutations use one reviewed batch. The CLI validates its paths, displays a bounded file diff or operation plan, and asks `Apply these changes? [y/N]`. Entering nothing declines. Credential-file contents are omitted from previews. Existing files require explicit replacement mode; creates and moves refuse overwrites. Replacements are staged in the same directory, flushed, rechecked against the approved original, then committed by rename. A failed staging write leaves the original intact. If a file changes while approval is pending or while its replacement is being staged, the operation stops instead of overwriting that edit.

Each completed file operation appears as it commits. If a batch fails or is interrupted, confirmed progress remains in the conversation so the assistant can distinguish completed files from unconfirmed operations. Remaining operations are not attempted; completed changes are not rolled back. On Windows, a staged replacement inherits directory permissions and may not retain custom permissions assigned to the original file.

Incomplete tool arguments and responses stopped at the model's output limit are rejected before their tool calls execute. The CLI explains how to retry with a smaller task rather than applying a partially generated file change.

Approval is required for mutations even in piped sessions. Non-interactive sessions decline file changes automatically and explain how to run an interactive review. Cancellation stops further operations; previously completed changes remain and should be checked before retrying.

## Piped input

Provide the API key through the environment before piping AI requests. For example, in PowerShell:

```powershell
@("Explain what a JavaScript closure is.", "/bye") | node cli.js --no-color
```

Input lines are queued until consumed, and end-of-input closes the session cleanly. If a piped multiline request ends at EOF after continuation lines, its collected content is submitted. Queued input is limited to 1 MiB or 1,024 lines; individual piped lines and accumulated multiline requests are also limited to 1 MiB. Exceeding these bounds fails with an actionable message instead of silently truncating input. The model-request limit of 32,000 characters still applies after input is collected. A non-interactive request failure sets a nonzero exit status. `/help` and `/status` can also be piped without credentials.

Pipes use plain output and do not display the interactive suggestion menu or automatic follow-up footer. Explicit `/followups` prints the available suggestions. `/1`, `/2`, or `/3` prints the suggested prompt for separate submission; it does not run that prompt or consume the following input line.

## Project structure

```text
bin/                         Published CLI executable
src/
  app/                       Startup, flags, and lifecycle
  agent/                     LangGraph, routing, tool execution, conversation state
  config/                    Paths and local settings
  providers/                 Provider configuration, authentication, model factory
  security/                  Serialized approval prompts
  tools/files/               Bounded workspace filesystem tools
  ui/                        Input, Markdown streaming, presentation, sanitization
tests/                       Automated regression tests
scripts/                     Syntax checks and isolated test-environment preload
docs/                        Architecture notes
outputs/                     Generated user-facing deliverables
```

## Development and verification

Run `npm test` for the automated regression suite and `npm run check` to syntax-check every JavaScript source, launcher, script, and test. To run a focused test with the same isolation, use a command such as `npm test -- tests/unit/terminal-input.test.js`.

The test command preloads `scripts/test-environment.js` before application imports. It creates a temporary home and workspace, removes inherited provider credentials, and disables LangChain/LangSmith tracing. Run tests through `npm test`; direct `node --test` bypasses this preload and its profile protection.

Tests cover input buffering and cancellation, multiline input, provider configuration and failures, streamed rendering, tool execution guards, approval behavior, and filesystem safety. Alongside injected model streams, integration tests exercise the real OpenAI SDK against a loopback HTTP server with a dummy key, including streaming, split tool arguments, rate limits, cancellation, deadlines, and broken connections. They do not contact a live model provider or make billable API calls. The POSIX file-permission preservation test is skipped on Windows.

There are no separate style-lint or build scripts. This is a Node.js ESM application; development runs directly from source. See [architecture notes](docs/architecture.md) for component responsibilities and safety limits.

Live provider connectivity and account-specific model availability require real credentials and a separate smoke test. Real terminal behavior can vary by host, font, and shell; automated layout tests do not establish compatibility with every terminal. Filesystem validation is not an operating-system sandbox against another process changing paths at the exact instant of an operation. Tool routing uses local intent matching, and long conversations are trimmed rather than summarized by another model call.

## Logout

Use `/logout` to remove the local `.puls-ai` profile, including all saved provider API keys, settings, and command history, and exit the session. The CLI requires fresh interactive yes/no confirmation; an empty answer, no, or Ctrl+C cancels. Piped input cannot confirm deletion. Pending history saves finish before deletion so they cannot recreate the profile. Workspace files are preserved. Keys exported in the parent shell remain there and must be unset separately if desired; local logout does not revoke provider-side API keys.

## Optional Telegram bot

After provider setup, interactive onboarding asks `Connect Telegram Bot? (Y/n)`; enter `n` or `Skip` to continue without Telegram. To connect, get a bot token from BotFather, enter it at the hidden prompt, and supply a comma-separated allowlist of numeric Telegram **user IDs** (not usernames or chat/group IDs). An empty allowlist is rejected. A bot already using a webhook must have that webhook removed by its owner before Puls can poll it. Setup validates `getMe` and saves only encrypted token data.

Use `/telegram status`, `/telegram connect`, `/telegram reconfigure`, or `/telegram disconnect` later. `/settings telegram <action>` provides the same settings. Disconnect removes the saved token. `/status` includes connection state. `/logout` stops Telegram before removing the Puls profile.

The CLI must stay running for the bot to reply. Authorized users can send private messages and use `/start`, `/help`, `/status`, and `/reset`. Each user has separate in-memory context, bounded and trimmed by the existing agent helpers; `/reset`, disconnect, application exit, or an hour of inactivity clears that context. Groups, bots, and unlisted users cannot reach the model or workspace. Telegram reuses the existing LangGraph and provider with a read-only tool policy; file changes still require the local CLI approval flow.

Tokens use Windows DPAPI tied to the current Windows user. On macOS/Linux, AES-256-GCM protects the token with a local owner-only key file in `.puls-ai`; protect the whole profile and backups, since this is not a system keychain. Tokens are redacted from messages/errors. No extra packages, public server, or webhook are needed. The long-poll loop uses bounded reconnection backoff, respects Telegram retry delays, and aborts on shutdown. Authentication/webhook/duplicate-poller conflicts appear in connection status. Poll offsets are saved before processing to avoid rerunning agent turns after delivery failures; a crash at that boundary can lose a message, so inspect the conversation and resend intentionally. Initial connection skips previously queued bot messages. Live account connectivity requires your own bot token; automated tests use dummy tokens and loopback HTTP only.

API reference: https://core.telegram.org/bots/api

# Puls AI CLI

Puls AI is a local-first coding assistant with a LangGraph agent, streamed terminal responses, and approval-based workspace file tools. It supports Groq, OpenAI, and Google model providers.

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

Help, version, and slash commands work without an API key. An interactive session asks for a missing key only when the first AI request starts; key entry is hidden.

## Providers and configuration

| Provider | `PULS_PROVIDER` | Default model | API-key variable |
| --- | --- | --- | --- |
| Groq | `groq` (default) | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| OpenAI | `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` |
| Google | `google` | `gemini-2.5-flash` | `GOOGLE_API_KEY` |

Set a provider-specific key, use the existing `PULS_API_KEY` fallback, or enter a key at the interactive prompt. Provider-specific environment keys take precedence. Keys entered through the prompt are saved to the local settings file; environment keys are not saved. Groq keys are validated once per session; other providers authenticate through their first model request.

Example in PowerShell:

```powershell
$env:PULS_PROVIDER = "openai"
$env:OPENAI_API_KEY = "your-api-key"
$env:PULS_AI_WORKSPACE = "C:\path\to\your\project"
node cli.js
```

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

| Command | Action |
| --- | --- |
| `/help` | List commands and keyboard shortcuts |
| `/status` | Show model, provider, workspace, agent state, and completed turns |
| `/clear` | Clear an interactive terminal |
| `/bye` | Exit and clean up terminal input |

Unknown slash commands show a suggestion and do not call the model.

- **Tab:** complete slash commands; press again to list matching commands.
- **Up / Down:** navigate input history, or cycle command matches after `/`.
- **Multiline:** end a line with a single `\` to continue onto the next line. Submit a final line without the trailing `\`, or an empty line, to send the request. A doubled trailing `\\` is literal.
- **Ctrl+C:** cancel an active request or clear the current input. Press again while idle to exit.
- **Ctrl+D:** exit when the input is empty.

Only recognized slash commands persist in `.puls-ai/history.json`. Ordinary requests and credential input are not written to that history file. Conversation context remains in memory for the current session.

Pasted multiline input is retained across continuation prompts. Approval and credential prompts require fresh input: queued pasted commands cannot answer them. Cancelling a partly entered key clears it before terminal echo resumes.

## Responses and file changes

The welcome screen shows the active model, workspace, and session state. Assistant responses render Markdown, tables, lists, and language-labeled code blocks. Complete Markdown blocks appear progressively; fenced code is buffered until it closes so highlighting remains stable. Tool activity identifies the file or directory being accessed. Layouts use the current terminal width, colors are disabled for pipes, and loading indicators stay out of non-interactive output.

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

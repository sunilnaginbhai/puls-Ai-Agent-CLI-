# Puls AI architecture

Puls AI is a local-first Node.js command-line application. The CLI owns terminal interaction and local filesystem tools. The LangGraph agent coordinates model requests and tool calls. Provider integrations and local settings remain separate from the terminal interface.

## Folder responsibilities

```text
bin/                       Published executable entry point
src/
  app/                     Startup and application lifecycle
  agent/                   LangGraph graph and model node
  config/                  Config paths and local settings storage
  providers/               Model/provider adapters and configuration
  security/                User permission prompts
  tools/                   Agent tools grouped by capability
    files/                 Workspace-aware filesystem tools
  ui/                      Readline, spinner, response/error formatting
tests/
  unit/                    Isolated unit tests
docs/                      Project architecture and contributor notes
outputs/                   Generated user-facing deliverables
```

## Main execution path

1. `bin/puls-ai.js` starts the application. The root `cli.js` is retained as a compatibility launcher for existing `node cli.js` workflows.
2. `src/app/main.js` handles startup and API-key setup.
3. `src/agent/agent.graph.js` owns the LangGraph graph, terminal loop, and command routing.
4. `src/agent/model.node.js` initializes the model and binds agent tools.
5. `src/tools/files/file.tools.js` implements filesystem operations and workspace path validation.
6. `src/security/permission.prompt.js` handles approval prompts using the shared readline instance in `src/ui/readline.js`.
7. `src/ui/` contains terminal-only presentation helpers. Formatting should not change the message history or tool results.

## Development checks

Run tests with `npm test`. Start the CLI with `npm start`; run it with automatic restarts using `npm run dev`. Use `npm ci` to install from the lockfile. Never commit API keys, local settings, build output, or `node_modules`.

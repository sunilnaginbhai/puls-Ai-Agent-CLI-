# Puls AI CLI

Puls AI is a local-first coding assistant for working with projects from the terminal.

## Requirements

- Node.js 22.12 or later
- An API key for the configured model provider

## Install and run

```powershell
npm install
npm start
```

For development with automatic restarts:

```powershell
npm run dev
```

The installed command is exposed as `puls-ai` through the package `bin` entry.

## Project structure

```text
bin/
  puls-ai.js                 CLI executable entry point
src/
  app/                       Startup and application lifecycle
  agent/                     LangGraph graph and model node
  config/                    Application paths and settings storage
  providers/                 Model/provider adapters and configuration
  security/                  Permission prompts and approval flow
  tools/                     Agent tools, grouped by capability
    files/                   Workspace filesystem tools
  ui/                        Terminal input, spinner, rendering, errors
outputs/                     Generated user-facing deliverables
docs/                        Architecture and development documentation
tests/                       Automated tests
```

## CLI commands

- `/help` — show available commands
- `/status` — show session status
- `/clear` — clear the terminal
- `/bye` — exit

## Workspace

Filesystem tools use the directory from which the CLI is launched as the workspace by default. To set a different root in PowerShell before starting the CLI:

```powershell
$env:PULS_AI_WORKSPACE = "C:\\path\\to\\your\\project"
npm start
```

## Development notes

Keep credentials and local environment files out of source control. Do not commit `node_modules`; install dependencies from the lockfile with `npm ci`.

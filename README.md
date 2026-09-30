# Cosmos

A desktop app for the [pi coding agent](https://github.com/earendil-works/pi), with the quality-of-life features of a modern agent desktop client.

## Features

- **Workspace dashboard**: the new-session screen lists your core company repos and experiments. Missing repos get a one-click **Clone** (`git@github.com:<org>/<repo>.git`, org configurable in Settings) with live git progress, or **Link existing…** to symlink a checkout you already have elsewhere on disk into the workspace root. Linked entries are badged and can be unlinked without touching the original folder.
- **Sessions sidebar**: every pi session on disk, grouped by project, with pinning, full-text search (⌘K), rename, export to HTML, and move to Trash. It updates live as sessions change, including ones created by the pi CLI.
- **Concurrent sessions**: each session runs its own pi process. Background sessions keep working, show a spinner, and notify you when they finish or need input. The dock badge counts sessions waiting for you.
- **Streaming transcript**: markdown with syntax highlighting and copy buttons, collapsible thinking, and per-tool cards (bash, read, edit/write with diffs, grep/find/ls). Retries and compaction appear inline.
- **Permission modes** (pi has none built in): *Ask*, *Accept edits*, and *Auto*, switchable per session. Approvals appear as cards showing the exact command or diff, with an "always allow this tool" option.
- **Composer**: `/` command autocomplete (pi prompt templates, skills, extension commands, and desktop commands), `@` fuzzy file mentions (respects `.gitignore`), and image paste, drag-and-drop, or attach. `!cmd` runs a shell command; `!!cmd` keeps its output out of the model's context.
- **While pi works**: Enter steers and ⌥Enter queues a follow-up (swappable in Settings). Queued messages are shown and editable. Esc stops, and anything queued returns to the composer.
- **Model and thinking pickers**, a context-window meter, and session cost.
- **Edit & fork**: edit any earlier message to branch a new session from it, or fork the whole session.
- **Changes panel** (⌘⇧D): every file pi changed in the session, with diffs and "open in editor".
- **Native sign-in** for every pi provider: subscription OAuth (Claude, ChatGPT/Codex, Copilot, …) and API keys, using pi's own login flows. Credentials go to pi's `auth.json`, so the CLI and the app share them.
- **MCP visibility and local overrides**: Settings → *MCPs* shows the active Glayvin MCP servers, whether OAuth-backed servers have local tokens, and lets you add/edit/remove personal MCP entries in your local Glayvin override file.
- **Cosmos-managed profile by default**: the app uses its own Pi home by default, so GUI sessions keep a separate session/auth store from terminal work. If Glayvin is installed, Cosmos still passes through its shared home automatically so MCP config, prompts, skills, and company context remain available. You can still point Cosmos at an existing Pi or Glayvin home when you want to fully share sessions, auth, prompts, skills, and agents.
- **Mac niceties**: login-shell PATH resolution (Homebrew and nvm tools work in bash), open project in Finder/editor/Terminal, remembered window size, light/dark/system theme, and system notifications.

## How it works

```
Renderer (React)  ⇄  IPC (validated)  ⇄  Main process
                                          ├─ SessionHost → one `pi --mode rpc` child per session
                                          │     (Electron-as-Node + launcher + desktop-bridge extension)
                                          ├─ SessionIndex → pi's SessionManager + fs watcher
                                          └─ AuthService  → pi's ModelRuntime.login()
```

- The app icon is `build/icon.svg`; after editing it run `npx electron scripts/render-icon.cjs` to regenerate `build/icon.png`.
- Pi is bundled as an npm dependency and runs on Electron's embedded Node, so users don't need Node installed. You can point Settings → *Custom pi CLI* at your own build instead.
- By default, Cosmos seeds a separate managed Pi profile from any existing login and model defaults it can find, without copying the terminal session store or terminal-specific permission rules. If a Glayvin home is already available, Cosmos also passes it through automatically so shared MCP config and company context still load in GUI sessions. Settings → *pi configuration folder* is the advanced escape hatch when you explicitly want to reuse an existing Pi or Glayvin home. If that folder is a Glayvin-style `.../.pi/agent`, Cosmos also infers `GLAYVIN_HOME` automatically.
- `resources/pi-extension/desktop-bridge.ts` is a small pi extension. It implements permission modes over pi's extension-UI protocol and does nothing outside the desktop app.
- Idle background sessions give up their process after a configurable time and restart transparently when you return.

## Installation

### Clone and run locally

```bash
git clone git@github.com:wbraden/cosmos-gui.git
cd cosmos-gui
npm install
npm run dev
```

### Recommended prerequisites

- Node.js 20+
- npm
- macOS (required for the Electron desktop app and Mac packaging flow)

### Validate before shipping changes

```bash
npm run typecheck
npm test             # unit + end-to-end tests (real pi against a scripted fake model)
```

### Build a production app

```bash
npm run dist         # dist/Cosmos-<version>-arm64.dmg
```

After building, open the generated DMG from `dist/` and drag **Cosmos** into your Applications folder.

## Develop

```bash
npm install
npm run dev          # hot-reloading app
npm test             # unit + end-to-end tests (real pi against a scripted fake model)
npm run typecheck
```

Try the app without an API key by pointing it at the scripted fake model:

```bash
node scripts/fake-llm-server.mjs 4891 &
node scripts/fake-pi-home.mjs /tmp/fake-pi 4891
PI_CODING_AGENT_DIR=/tmp/fake-pi npm run dev
```

`node scripts/ui-smoke.mjs <outDir>` (after `npm run build`) drives the built app over the DevTools protocol through a full conversation and saves screenshots.

## Build a Mac app

```bash
npm run dist         # dist/Cosmos-<version>-arm64.dmg
```

The build is unsigned. Signing and notarization need an Apple Developer ID; set `CSC_LINK`/`APPLE_ID` for electron-builder.

## Logs

Logs go to `~/Library/Logs/Cosmos/main.log` (Help → Show Logs). Crash dumps are kept locally.

# Workspace Keeper

Cross-platform TUI for discovering, ranking, and launching project commands from manifests, shell history, and SSH history.

Workspace Keeper scans a workspace root, finds runnable project capabilities, ranks them by real usage signals, separates remote SSH control, and lets you launch selected commands in Ghostty when available. The TUI is the primary interface. The CLI owns scanning, classification, reporting, and archive dry-runs. The web server remains available as an optional legacy view over generated data.

## Install

From a checkout:

```bash
npm install
npm link
workspace-keeper tui --root ~/workspaces --out ~/.local/share/workspace-keeper
```

From GitHub once published:

```bash
npm install -g github:OWNER/workspace-keeper
workspace-keeper tui --root ~/workspaces
```

From npm once the package name is published:

```bash
npm install -g workspace-keeper
workspace-keeper tui --root ~/workspaces
```

Node.js 18 or newer is required.

## Commands

```bash
workspace-keeper tui [--root PATH] [--out PATH] [--refresh]
workspace-keeper scan [--root PATH] [--out PATH] [--quick] [--json]
workspace-keeper plan [--out PATH] [--refresh] [--json]
workspace-keeper report [--out PATH]
workspace-keeper serve [--root PATH] [--out PATH] [--port 4789]
workspace-keeper archive (--project NAME | --all-ready) [--execute] [--force] [--prune-generated] [--compact]
workspace-keeper restore --archive PATH [--target-root PATH] [--execute] [--force] [--keep-archive]
```

Local development shortcuts:

```bash
npm run tui
npm run scan
npm run plan
npm run report
npm run serve
npm test
```

## TUI Controls

- `j` / `k` or arrow keys: move selection.
- Mouse click: select a row or run button.
- Mouse wheel: scroll the pane under the cursor.
- `/`: focus the filter input.
- `Enter`: run the selected command only when the input is empty.
- `Ctrl+X`: turn non-empty input into a pending execution snapshot.
- `r`: refresh projects, shell history, and remote commands without leaving the TUI.
- `g`: switch between local projects and remote control.
- `Esc`: clear input or cancel pending state.
- `q`: quit.

## Ghostty Integration

Workspace Keeper is not a native Ghostty plugin. Ghostty currently exposes configuration, keybindings, shell integration, CLI launch options, and macOS AppleScript automation, but not a general third-party plugin API for adding buttons directly to the Ghostty chrome.

The practical integration model is:

```bash
ghostty -e workspace-keeper tui --root ~/workspaces
```

You can also make Workspace Keeper the first Ghostty surface with Ghostty config:

```text
initial-command = workspace-keeper tui --root ~/workspaces
```

On macOS, the optional wrapper keeps a single Workspace Keeper TUI instance for a Ghostty-launched session:

```bash
bin/workspace-keeper-ghostty-tui --check
```

The wrapper is configurable through environment variables:

- `WORKSPACE_KEEPER_PROJECT_DIR`
- `WORKSPACE_KEEPER_NODE_BIN`
- `WORKSPACE_KEEPER_TUI_SCRIPT`
- `WORKSPACE_KEEPER_WORKSPACE_ROOT`
- `WORKSPACE_KEEPER_DATA_DIR`

When launching selected commands, macOS uses Ghostty's AppleScript automation to open a new tab. Other platforms try the `ghostty` CLI via `ghostty -e ...`, which may open a new Ghostty surface depending on the platform.

## Cross-Platform Scope

Core features are designed to run on macOS, Linux, and Windows:

- workspace scanning
- manifest/script discovery
- shell history ranking where readable history files exist
- SSH config parsing
- TUI navigation, filtering, refresh, and mouse wheel support
- JSON scan/plan/report output

Platform-specific boundaries:

- macOS has the richest Ghostty tab automation through AppleScript.
- Linux works best when `ghostty` is available in `PATH`.
- Windows support is for the Node CLI/TUI core; command launching depends on the installed terminal and shell behavior.

## Data

Generated files are written under `--out`:

- `latest-scan.json`
- `latest-plan.json`
- `ghostty-sent-events.json`

If `--out` is omitted, local development uses `data/` inside this checkout.

## Archive And Restore

`archive` is dry-run by default. With `--execute`, it creates or updates `PROJECT/PROJECT.tar.gz`. Git history under `.git` and source files are included. Rebuildable dependency/build directories such as `node_modules`, `.venv`, `venv`, `dist`, `build`, and `target` are excluded.

With `--prune-generated`, rebuildable directories are moved to the platform trash after the archive is created while source files remain on disk. With `--compact`, every project entry except `PROJECT.tar.gz` is moved to trash after the archive is created. Projects with dirty Git state, nested Git repositories, local config/data files, or snapshot-only status are refused unless `--force` is provided.

`restore` is dry-run by default. With `--execute`, it extracts a `.tar.gz` archive into the workspace root or `--target-root`, including any `.git` history stored in the archive. If the target project directory already exists, restore is refused unless `--force` is provided.

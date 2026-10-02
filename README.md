# Scripts

Run a `package.json` script, watch what it prints, and stop or restart it from the footer —
the Flutter plugin's shape, for the JavaScript half of a project.

## What it does

- **Finds the scripts.** Every `package.json` with scripts in the workspace, nested ones
  included (a monorepo's `apps/*` and `packages/*`, a frontend beside a backend), three folders
  deep. `node_modules` and build output are never searched.
- **Picks the package manager** from the lockfile — `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`
  or `package-lock.json` — looking upward, so a package inside a pnpm workspace runs with pnpm.
- **Runs it with Deck holding the process.** The output goes to the drawer (or a pane), with a
  filter, copy and clear, and a dev server's local address becomes a link. Stop ends the whole
  process tree, so nothing is left holding the port.
- **Notices scripts typed in a terminal.** `npm run dev` in a pane shows in the footer and the
  drawer, and stop and restart work on it with Ctrl+C. Its output stays in the terminal; the
  drawer offers a jump to it.
- **Keeps workspaces apart.** Only the active workspace's runs are shown, plus any run no
  workspace claims, so one an agent started elsewhere can still be stopped.

## What it exports

| Export | Where it renders |
|---|---|
| `Status` | the footer: ▶ to pick a script, or the running one with restart and stop |
| `Panel` | a drawer tab beside Console: the runs and their output |
| `PaneView` | the same view as a pane in the Workspaces split tree |
| `commands` | palette entries: run any script here, stop or restart a running one |
| `mcp` | `npm_list`, `npm_run`, `npm_stop`, `npm_restart`, `npm_log` |

## Limits

- A script typed in a terminal is attributed to the workspace's folder, not the folder the
  terminal is in: Deck tells plugins a pane's workspace, not its current directory.
- Restarting a terminal run waits a fixed moment for the prompt before retyping the command.
  Under `cmd.exe`, a `.cmd` shim asks "Terminate batch job (Y/N)?" first, and the retyped
  command answers that instead. PowerShell, Deck's default shell, never asks.

## Checks

```sh
node plugins/npm/npm.check.mjs
```

## Build

```sh
node plugins/npm/build.mjs
```

// The parts of running package scripts that are plain string logic: reading a package.json,
// choosing the package manager, recognising a script run in a terminal, and pulling a dev
// server's address out of its output.
//
// No Deck imports, so npm.check.mjs can test all of it without the app running.

/** One process row as Deck's sweep publishes it (term-procs.json). */
export interface PaneProc { name: string; cmd: string }
export type PaneProcs = Record<string, PaneProc[]>;

export type Manager = "npm" | "pnpm" | "yarn" | "bun";

/** Trailing separators and case dropped, backslashes normalised, so two spellings compare equal. */
export const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * A package.json's name and scripts, or null when it is not one worth offering.
 *
 * A package with no scripts is skipped rather than listed empty: in a monorepo most packages
 * are libraries with nothing to run, and a menu of empty rows hides the ones that matter.
 */
export function parsePackage(json: string): { name: string; scripts: Record<string, string> } | null {
  let pkg: unknown;
  try { pkg = JSON.parse(json); } catch { return null; }
  if (!pkg || typeof pkg !== "object") return null;
  const p = pkg as { name?: unknown; scripts?: unknown };
  if (!p.scripts || typeof p.scripts !== "object") return null;
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.scripts as Record<string, unknown>)) {
    if (typeof v === "string") scripts[k] = v;
  }
  if (!Object.keys(scripts).length) return null;
  return { name: typeof p.name === "string" ? p.name : "", scripts };
}

/**
 * Which package manager a folder uses, from the lockfile beside its package.json.
 *
 * `lockfilesUp` is every file name in the folder and its ancestors up to the workspace root,
 * nearest first: a package inside a pnpm or yarn workspace has no lockfile of its own, and
 * running it with npm instead would ignore the workspace's links. The nearest lockfile wins.
 * No lockfile at all is npm, which is what a package with nothing installed yet would get.
 */
export function packageManager(lockfilesUp: readonly string[][]): Manager {
  for (const names of lockfilesUp) {
    if (names.includes("pnpm-lock.yaml")) return "pnpm";
    if (names.includes("yarn.lock")) return "yarn";
    if (names.includes("bun.lockb") || names.includes("bun.lock")) return "bun";
    if (names.includes("package-lock.json")) return "npm";
  }
  return "npm";
}

/**
 * The command line to run a script, through cmd.exe.
 *
 * cmd rather than the manager directly: each one is a .cmd shim on Windows, which Rust's
 * Command cannot launch, and cmd also gives PATH resolution. `run` is passed for every manager
 * so a script named like a built-in command (`install`, `test` in yarn) still runs the script.
 */
export function runCommand(pm: Manager, script: string): { program: string; args: string[] } {
  return { program: "cmd", args: ["/C", pm, "run", script] };
}

/** The same thing as a person would type it, for typing into a terminal. */
export const typedCommand = (pm: Manager, script: string) => `${pm} run ${script}`;

/** Split a Windows command line into words, dropping the quotes around any of them. */
export function words(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((w) => w !== "");
}

/** What each manager's entry script is called, as it shows up in node's command line. */
const CLI: [RegExp, Manager][] = [
  [/[\\/]npm-cli\.js$/i, "npm"],
  [/[\\/]pnpm\.c?js$/i, "pnpm"],
  [/[\\/]yarn\.c?js$/i, "yarn"],
];

/**
 * Commands that are the manager's own rather than a script: `pnpm install` must not be listed
 * as a running script called "install". Only consulted for the managers that run a script
 * without `run` (pnpm, yarn, bun); npm needs `run` (or start/test) to run one at all.
 */
const BUILTIN = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "outdated",
  "exec", "dlx", "x", "create", "init", "link", "unlink", "publish", "pack", "audit", "why",
  "list", "ls", "info", "view", "config", "set", "cache", "store", "import", "rebuild",
  "patch", "login", "logout", "whoami", "version", "help", "self-update", "global", "bin",
  "workspace", "workspaces", "dedupe", "prune", "fetch", "install-test", "ci",
]);

/** Flags whose value is the following word rather than joined with `=`. */
const VALUE_FLAGS = new Set([
  "--filter", "-F", "--dir", "-C", "--prefix", "--workspace", "--cwd", "--cache", "--registry",
]);

/**
 * Is this process row a package script someone started in a terminal, and if so which?
 *
 * The row to look for is the node process running the manager's own CLI — `npm run dev` is
 * `node …\npm-cli.js run dev` underneath, whatever shell typed it. Its children (cmd running
 * vite, then node running vite.js) are not matched: they are the script's body, and matching
 * them too would report one run several times.
 */
export function scriptRun(p: PaneProc): { pm: Manager; script: string } | null {
  const name = p.name.toLowerCase();
  const w = words(p.cmd);
  let pm: Manager | null = null;
  let rest: string[] = [];
  if (name === "bun.exe") {
    pm = "bun";
    rest = w.slice(1);
  } else if (name === "node.exe") {
    const at = w.findIndex((x) => CLI.some(([re]) => re.test(x)));
    if (at < 0) return null;
    pm = CLI.find(([re]) => re.test(w[at]))![1];
    rest = w.slice(at + 1);
  } else {
    return null;
  }
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (!x.startsWith("-")) { args.push(x); continue; }
    // A flag taking a value as the next word: `pnpm --filter web dev` runs dev, not "web".
    if (VALUE_FLAGS.has(x)) i++;
  }
  const [first, second] = args;
  if (!first) return null;
  if (first === "run" || first === "run-script") return second ? { pm, script: second } : null;
  // npm's two shorthands that are scripts; everything else npm runs is its own command.
  if (pm === "npm") return first === "start" || first === "test" ? { pm, script: first } : null;
  if (BUILTIN.has(first)) return null;
  // bun runs a FILE as readily as a script, and `bun index.ts` is not a package script.
  if (pm === "bun" && /\.[cm]?[jt]sx?$/i.test(first)) return null;
  return { pm, script: first };
}

/**
 * Folders never searched for package.json. node_modules above all — every dependency has one —
 * build output, which often carries a copied package.json of its own, and scaffolding templates
 * and test fixtures, whose package.json is a placeholder ("name": "__ID__") rather than
 * something to run.
 */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "vendor",
  "template", "templates", "fixtures", "__fixtures__",
]);

/** Whether the search should look inside a folder of this name. Hidden folders never. */
export function shouldDescend(name: string): boolean {
  return !name.startsWith(".") && !SKIP_DIRS.has(name);
}

/**
 * Which workspace a directory belongs to: the one whose folder contains it, the deepest when
 * workspaces nest. Null when none does.
 *
 * Runs are attributed this way rather than by recording the workspace that started them,
 * because an agent starts runs over MCP with only a directory to go on. The Flutter plugin has
 * the same function; plugins cannot import from one another, so each carries its own.
 */
export function ownerWorkspace(
  workspaces: readonly { id: string; cwd: string }[], dir: string,
): string | null {
  const f = norm(dir);
  let best: { id: string; len: number } | null = null;
  for (const w of workspaces) {
    const c = norm(w.cwd);
    if (!c || (f !== c && !f.startsWith(c + "/"))) continue;
    if (!best || c.length > best.len) best = { id: w.id, len: c.length };
  }
  return best?.id ?? null;
}

/** A package's label in the picker: its name, else its path under the workspace. */
export function packageLabel(root: string, dir: string, name: string): string {
  if (name) return name;
  const r = norm(root);
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm(d) === r) return d.split("/").pop() || d;
  return norm(d).startsWith(r + "/") ? d.slice(r.length + 1) : d;
}

/** Terminal colour codes, which a tool still emits when it decides colour is wanted anyway. */
export const stripAnsi = (s: string) =>
  s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");

/**
 * The local addresses a line announces — "Local: http://localhost:5173/" and the like.
 *
 * Only loopback: a dev server prints its LAN address too, and the one you click from this
 * machine is the local one. 0.0.0.0 is rewritten to localhost, since a browser cannot open it.
 */
export function localUrls(line: string): string[] {
  const out: string[] = [];
  for (const m of stripAnsi(line).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'")\]]*)?/gi)) {
    const url = m[0].replace(/\/\/0\.0\.0\.0/, "//localhost").replace(/[.,;:]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// The agent-facing tools for package scripts.
//
// Two kinds of run, as in the plugin's UI, and every tool covers both:
//
//   plugin — started through Deck (here or from the footer). Deck owns the process and keeps its
//            log, so npm_log can read it.
//   pane   — a script someone typed in a terminal. Stopped with Ctrl+C, because that is all a
//            terminal takes; its output is read with deck_term_read.
//
// Reads come from files the frontend publishes (plugin-npm-runs, term-procs); writes go through
// Deck's HTTP API. Nothing here reaches into the webview, because nothing can.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  parsePackage, packageManager, scriptRun, shouldDescend, typedCommand, type Manager, type PaneProcs,
} from "./detect.js";
import type { DeckMcp, McpServer } from "../shim/mcp.js";

interface StateLine { ts: number; kind: string; text: string }
interface StateRun {
  id: string; cwd: string; pkg: string; script: string; pm: Manager;
  status: string; code: number | null; urls: string[]; log: StateLine[];
}

/** A run of either kind, flattened to what a caller acts on. */
interface AnyRun {
  kind: "plugin" | "pane";
  /** A run id for a plugin run, a pane id for a pane run. */
  id: string;
  cwd: string;
  script: string;
  pm: Manager;
  status: string;
  urls: string[];
}

/** The lockfile names in a folder and each one above it, nearest first, up to the drive root. */
function lockfilesUp(dir: string): string[][] {
  const out: string[][] = [];
  for (let d = dir, i = 0; i < 12; i++) {
    try { out.push(readdirSync(d)); } catch { out.push([]); }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** The packages with scripts under a folder, the same search the plugin's picker makes. */
function packagesUnder(root: string) {
  const found: { dir: string; name: string; scripts: Record<string, string>; pm: Manager }[] = [];
  let level = [root];
  for (let depth = 0; depth <= 3 && level.length && found.length < 200; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (entries.some((e) => e.isFile() && e.name === "package.json")) {
        try {
          const p = parsePackage(readFileSync(join(dir, "package.json"), "utf8"));
          if (p) found.push({ dir, ...p, pm: packageManager(lockfilesUp(dir)) });
        } catch { /* unreadable: skipped */ }
      }
      for (const e of entries) if (e.isDirectory() && shouldDescend(e.name)) next.push(join(dir, e.name));
    }
    level = next;
  }
  return found;
}

export function register(server: McpServer, deck: DeckMcp) {
  const { z, ok, readJson, deckApi, apiErr } = deck;

  const pluginRuns = (): StateRun[] =>
    readJson<{ runs: StateRun[] }>("plugin-npm-runs", { runs: [] }).runs ?? [];

  /** Terminal panes running a script, from Deck's process sweep, with the same matcher the UI uses. */
  async function paneRuns(): Promise<AnyRun[]> {
    const procs = readJson<PaneProcs>("state/term-procs", {});
    const hits = Object.entries(procs)
      .map(([id, rows]) => ({ id, run: rows.map(scriptRun).find(Boolean) }))
      .filter((h): h is { id: string; run: { pm: Manager; script: string } } => !!h.run);
    if (!hits.length) return [];
    let panes: { id: string; cwd?: string }[] = [];
    try {
      const r = await deckApi("/dt/list");
      if (r.ok) panes = await r.json();
    } catch { /* Deck unreachable: the ids are still real */ }
    return hits.map((h) => ({
      kind: "pane" as const, id: h.id, cwd: panes.find((p) => p.id === h.id)?.cwd ?? "",
      script: h.run.script, pm: h.run.pm, status: "running", urls: [],
    }));
  }

  async function allRuns(): Promise<AnyRun[]> {
    const mine = pluginRuns().map((r) => ({
      kind: "plugin" as const, id: r.id, cwd: r.cwd, script: r.script, pm: r.pm, status: r.status, urls: r.urls,
    }));
    return [...mine, ...(await paneRuns())];
  }

  /** What the caller meant: the id given, or the only live run. Ambiguity is an error, not a guess. */
  async function resolve(id?: string): Promise<AnyRun | string> {
    const runs = (await allRuns()).filter((r) => r.status !== "ended");
    if (id) return runs.find((r) => r.id === id) ?? `No live run with id ${id}. Use npm_list to see what is running.`;
    if (!runs.length) return "No script is running. Start one with npm_run.";
    if (runs.length > 1) {
      return "Several scripts are running — pass an id:\n" +
        runs.map((r) => `  ${r.id}  ${r.script}  (${r.cwd})`).join("\n");
    }
    return runs[0];
  }

  const command = (op: string, args: Record<string, unknown>) =>
    deckApi("/dt/plugin", { method: "POST", body: JSON.stringify({ plugin: "npm", op, args }) });

  const line = (r: AnyRun) =>
    `${r.kind === "plugin" ? "[deck]" : "[pane]"} ${r.id}  ${r.pm} run ${r.script}  ${r.status}  ${r.cwd}` +
    (r.urls.length ? `  ${r.urls.join(" ")}` : "");

  server.tool(
    "npm_list",
    "List running package scripts — both those Deck runs itself and `npm run …` (or pnpm, yarn, " +
      "bun) typed in a terminal pane. With `cwd`, also lists the scripts available under that " +
      "folder, nested packages included, with the package manager each would run with.",
    { cwd: z.string().optional().describe("a project folder, to list the scripts it can run") },
    async ({ cwd }) => {
      const runs = await allRuns();
      const out = runs.length ? runs.map(line) : ["(nothing running)"];
      if (!cwd) return ok(out.join("\n"));
      const pkgs = packagesUnder(cwd);
      out.push("", pkgs.length ? "Scripts:" : "No package.json with scripts under that folder.");
      for (const p of pkgs) {
        out.push(`  ${p.name || p.dir}  (${p.pm}, ${p.dir})`);
        for (const [s, body] of Object.entries(p.scripts)) out.push(`    ${s}: ${body}`);
      }
      return ok(out.join("\n"));
    },
  );

  server.tool(
    "npm_run",
    "Run a package script with Deck owning the process: its output is readable with npm_log, a " +
      "dev server's local URL is picked out of it, and npm_stop ends the whole process tree.",
    {
      cwd: z.string().describe("the folder holding the package.json"),
      script: z.string().describe("the script name, as in npm_list"),
      pm: z.enum(["npm", "pnpm", "yarn", "bun"]).optional()
        .describe("omit to choose from the lockfile, as the Deck UI does"),
    },
    async ({ cwd, script, pm }) => {
      let name = "";
      try { name = parsePackage(readFileSync(join(cwd, "package.json"), "utf8"))?.name ?? ""; } catch { /* unnamed */ }
      const manager = pm ?? packageManager(lockfilesUp(cwd));
      try {
        const r = await command("start", { cwd, pkg: name, script, pm: manager });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(`Starting \`${typedCommand(manager, script)}\` in ${cwd}. Read npm_log in a moment to see it come up.`);
      } catch (e) { return apiErr(e); }
    },
  );

  server.tool(
    "npm_stop",
    "Stop a running script.",
    { id: z.string().optional().describe("run id from npm_list; omit when only one is running") },
    async ({ id }) => {
      const run = await resolve(id);
      if (typeof run === "string") return ok(run);
      try {
        if (run.kind === "pane") {
          const r = await deckApi("/dt/keys", { method: "POST", body: JSON.stringify({ id: run.id, keys: ["C-c"] }) });
          return ok(r.ok ? `Sent Ctrl+C to the pane running ${run.script}.` : `Deck refused the keystroke: ${r.status}`);
        }
        const r = await command("stop", { id: run.id });
        return ok(r.ok ? `Stopping ${run.script}.` : `Deck refused the command: ${r.status} ${await r.text()}`);
      } catch (e) { return apiErr(e); }
    },
  );

  server.tool(
    "npm_restart",
    "Stop a running script and start it again.",
    { id: z.string().optional().describe("run id from npm_list; omit when only one is running") },
    async ({ id }) => {
      const run = await resolve(id);
      if (typeof run === "string") return ok(run);
      try {
        if (run.kind === "pane") {
          await deckApi("/dt/keys", { method: "POST", body: JSON.stringify({ id: run.id, keys: ["C-c"] }) });
          await new Promise((r) => setTimeout(r, 1200));
          const r = await deckApi("/dt/send", {
            method: "POST", body: JSON.stringify({ id: run.id, text: `${typedCommand(run.pm, run.script)}\r` }),
          });
          return ok(r.ok ? `Restarted ${run.script} in its pane. Read it with deck_term_read.` : `Deck refused: ${r.status}`);
        }
        const r = await command("restart", { id: run.id });
        return ok(r.ok ? `Restarting ${run.script}. It gets a new id — see npm_list.` : `Deck refused the command: ${r.status}`);
      } catch (e) { return apiErr(e); }
    },
  );

  server.tool(
    "npm_log",
    "Read a Deck-run script's output. Only for [deck] runs; a script in a terminal pane is read " +
      "with deck_term_read.",
    {
      id: z.string().optional().describe("run id from npm_list; omit when only one has run"),
      lines: z.number().int().positive().max(200).default(40),
      filter: z.string().optional().describe("only lines containing this text (case-insensitive)"),
    },
    async ({ id, lines, filter }) => {
      const runs = pluginRuns();
      if (!runs.length) return ok("No Deck-run script. One in a terminal pane is read with deck_term_read.");
      const run = id ? runs.find((r) => r.id === id) : runs.length === 1 ? runs[0] : undefined;
      if (!run) return ok("Several runs — pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.script}`).join("\n"));
      const needle = filter?.toLowerCase();
      const picked = (needle ? run.log.filter((l) => l.text.toLowerCase().includes(needle)) : run.log).slice(-lines);
      const when = (ts: number) => new Date(ts).toISOString().slice(11, 19);
      return ok(
        `${run.pm} run ${run.script} — ${run.status}${run.code !== null ? ` (exit ${run.code})` : ""}` +
        (run.urls.length ? `\n${run.urls.join("  ")}` : "") + "\n\n" +
        (picked.length ? picked.map((l) => `${when(l.ts)} ${l.text}`).join("\n") : "(no output yet)"),
      );
    },
  );
}

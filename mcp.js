// src/mcp.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// src/detect.ts
function parsePackage(json) {
  let pkg;
  try {
    pkg = JSON.parse(json);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;
  const p = pkg;
  if (!p.scripts || typeof p.scripts !== "object") return null;
  const scripts = {};
  for (const [k, v] of Object.entries(p.scripts)) {
    if (typeof v === "string") scripts[k] = v;
  }
  if (!Object.keys(scripts).length) return null;
  return { name: typeof p.name === "string" ? p.name : "", scripts };
}
function packageManager(lockfilesUp2) {
  for (const names of lockfilesUp2) {
    if (names.includes("pnpm-lock.yaml")) return "pnpm";
    if (names.includes("yarn.lock")) return "yarn";
    if (names.includes("bun.lockb") || names.includes("bun.lock")) return "bun";
    if (names.includes("package-lock.json")) return "npm";
  }
  return "npm";
}
var typedCommand = (pm, script) => `${pm} run ${script}`;
function words(cmd) {
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((w) => w !== "");
}
var CLI = [
  [/[\\/]npm-cli\.js$/i, "npm"],
  [/[\\/]pnpm\.c?js$/i, "pnpm"],
  [/[\\/]yarn\.c?js$/i, "yarn"]
];
var BUILTIN = /* @__PURE__ */ new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "outdated",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "link",
  "unlink",
  "publish",
  "pack",
  "audit",
  "why",
  "list",
  "ls",
  "info",
  "view",
  "config",
  "set",
  "cache",
  "store",
  "import",
  "rebuild",
  "patch",
  "login",
  "logout",
  "whoami",
  "version",
  "help",
  "self-update",
  "global",
  "bin",
  "workspace",
  "workspaces",
  "dedupe",
  "prune",
  "fetch",
  "install-test",
  "ci"
]);
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--filter",
  "-F",
  "--dir",
  "-C",
  "--prefix",
  "--workspace",
  "--cwd",
  "--cache",
  "--registry"
]);
function scriptRun(p) {
  const name = p.name.toLowerCase();
  const w = words(p.cmd);
  let pm = null;
  let rest = [];
  if (name === "bun.exe") {
    pm = "bun";
    rest = w.slice(1);
  } else if (name === "node.exe") {
    const at = w.findIndex((x) => CLI.some(([re]) => re.test(x)));
    if (at < 0) return null;
    pm = CLI.find(([re]) => re.test(w[at]))[1];
    rest = w.slice(at + 1);
  } else {
    return null;
  }
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (!x.startsWith("-")) {
      args.push(x);
      continue;
    }
    if (VALUE_FLAGS.has(x)) i++;
  }
  const [first, second] = args;
  if (!first) return null;
  if (first === "run" || first === "run-script") return second ? { pm, script: second } : null;
  if (pm === "npm") return first === "start" || first === "test" ? { pm, script: first } : null;
  if (BUILTIN.has(first)) return null;
  if (pm === "bun" && /\.[cm]?[jt]sx?$/i.test(first)) return null;
  return { pm, script: first };
}
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "template",
  "templates",
  "fixtures",
  "__fixtures__"
]);
function shouldDescend(name) {
  return !name.startsWith(".") && !SKIP_DIRS.has(name);
}

// src/mcp.ts
function lockfilesUp(dir) {
  const out = [];
  for (let d = dir, i = 0; i < 12; i++) {
    try {
      out.push(readdirSync(d));
    } catch {
      out.push([]);
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}
function packagesUnder(root) {
  const found = [];
  let level = [root];
  for (let depth = 0; depth <= 3 && level.length && found.length < 200; depth++) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.isFile() && e.name === "package.json")) {
        try {
          const p = parsePackage(readFileSync(join(dir, "package.json"), "utf8"));
          if (p) found.push({ dir, ...p, pm: packageManager(lockfilesUp(dir)) });
        } catch {
        }
      }
      for (const e of entries) if (e.isDirectory() && shouldDescend(e.name)) next.push(join(dir, e.name));
    }
    level = next;
  }
  return found;
}
function register(server, deck) {
  const { z, ok, readJson, deckApi, apiErr } = deck;
  const pluginRuns = () => readJson("plugin-npm-runs", { runs: [] }).runs ?? [];
  async function paneRuns() {
    const procs = readJson("state/term-procs", {});
    const hits = Object.entries(procs).map(([id, rows]) => ({ id, run: rows.map(scriptRun).find(Boolean) })).filter((h) => !!h.run);
    if (!hits.length) return [];
    let panes = [];
    try {
      const r = await deckApi("/dt/list");
      if (r.ok) panes = await r.json();
    } catch {
    }
    return hits.map((h) => ({
      kind: "pane",
      id: h.id,
      cwd: panes.find((p) => p.id === h.id)?.cwd ?? "",
      script: h.run.script,
      pm: h.run.pm,
      status: "running",
      urls: []
    }));
  }
  async function allRuns() {
    const mine = pluginRuns().map((r) => ({
      kind: "plugin",
      id: r.id,
      cwd: r.cwd,
      script: r.script,
      pm: r.pm,
      status: r.status,
      urls: r.urls
    }));
    return [...mine, ...await paneRuns()];
  }
  async function resolve(id) {
    const runs = (await allRuns()).filter((r) => r.status !== "ended");
    if (id) return runs.find((r) => r.id === id) ?? `No live run with id ${id}. Use npm_list to see what is running.`;
    if (!runs.length) return "No script is running. Start one with npm_run.";
    if (runs.length > 1) {
      return "Several scripts are running \u2014 pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.script}  (${r.cwd})`).join("\n");
    }
    return runs[0];
  }
  const command = (op, args) => deckApi("/dt/plugin", { method: "POST", body: JSON.stringify({ plugin: "npm", op, args }) });
  const line = (r) => `${r.kind === "plugin" ? "[deck]" : "[pane]"} ${r.id}  ${r.pm} run ${r.script}  ${r.status}  ${r.cwd}` + (r.urls.length ? `  ${r.urls.join(" ")}` : "");
  server.tool(
    "npm_list",
    "List running package scripts \u2014 both those Deck runs itself and `npm run \u2026` (or pnpm, yarn, bun) typed in a terminal pane. With `cwd`, also lists the scripts available under that folder, nested packages included, with the package manager each would run with.",
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
    }
  );
  server.tool(
    "npm_run",
    "Run a package script with Deck owning the process: its output is readable with npm_log, a dev server's local URL is picked out of it, and npm_stop ends the whole process tree.",
    {
      cwd: z.string().describe("the folder holding the package.json"),
      script: z.string().describe("the script name, as in npm_list"),
      pm: z.enum(["npm", "pnpm", "yarn", "bun"]).optional().describe("omit to choose from the lockfile, as the Deck UI does")
    },
    async ({ cwd, script, pm }) => {
      let name = "";
      try {
        name = parsePackage(readFileSync(join(cwd, "package.json"), "utf8"))?.name ?? "";
      } catch {
      }
      const manager = pm ?? packageManager(lockfilesUp(cwd));
      try {
        const r = await command("start", { cwd, pkg: name, script, pm: manager });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(`Starting \`${typedCommand(manager, script)}\` in ${cwd}. Read npm_log in a moment to see it come up.`);
      } catch (e) {
        return apiErr(e);
      }
    }
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
          const r2 = await deckApi("/dt/keys", { method: "POST", body: JSON.stringify({ id: run.id, keys: ["C-c"] }) });
          return ok(r2.ok ? `Sent Ctrl+C to the pane running ${run.script}.` : `Deck refused the keystroke: ${r2.status}`);
        }
        const r = await command("stop", { id: run.id });
        return ok(r.ok ? `Stopping ${run.script}.` : `Deck refused the command: ${r.status} ${await r.text()}`);
      } catch (e) {
        return apiErr(e);
      }
    }
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
          await new Promise((r3) => setTimeout(r3, 1200));
          const r2 = await deckApi("/dt/send", {
            method: "POST",
            body: JSON.stringify({ id: run.id, text: `${typedCommand(run.pm, run.script)}\r` })
          });
          return ok(r2.ok ? `Restarted ${run.script} in its pane. Read it with deck_term_read.` : `Deck refused: ${r2.status}`);
        }
        const r = await command("restart", { id: run.id });
        return ok(r.ok ? `Restarting ${run.script}. It gets a new id \u2014 see npm_list.` : `Deck refused the command: ${r.status}`);
      } catch (e) {
        return apiErr(e);
      }
    }
  );
  server.tool(
    "npm_log",
    "Read a Deck-run script's output. Only for [deck] runs; a script in a terminal pane is read with deck_term_read.",
    {
      id: z.string().optional().describe("run id from npm_list; omit when only one has run"),
      lines: z.number().int().positive().max(200).default(40),
      filter: z.string().optional().describe("only lines containing this text (case-insensitive)")
    },
    async ({ id, lines, filter }) => {
      const runs = pluginRuns();
      if (!runs.length) return ok("No Deck-run script. One in a terminal pane is read with deck_term_read.");
      const run = id ? runs.find((r) => r.id === id) : runs.length === 1 ? runs[0] : void 0;
      if (!run) return ok("Several runs \u2014 pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.script}`).join("\n"));
      const needle = filter?.toLowerCase();
      const picked = (needle ? run.log.filter((l) => l.text.toLowerCase().includes(needle)) : run.log).slice(-lines);
      const when = (ts) => new Date(ts).toISOString().slice(11, 19);
      return ok(
        `${run.pm} run ${run.script} \u2014 ${run.status}${run.code !== null ? ` (exit ${run.code})` : ""}` + (run.urls.length ? `
${run.urls.join("  ")}` : "") + "\n\n" + (picked.length ? picked.map((l) => `${when(l.ts)} ${l.text}`).join("\n") : "(no output yet)")
      );
    }
  );
}
export {
  register
};

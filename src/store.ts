// The running scripts, outside React.
//
// Deck unmounts a module on navigation, so anything that must outlive a tab switch lives in a
// module-level store and components subscribe with useSyncExternalStore — the same rule Deck's
// own terminals follow. A dev server keeps running while you look at something else, and so must
// its log.
import { procStream, procKill, configWrite } from "../shim/bridge.js";
import { listen } from "@tauri-apps/api/event";
import { runCommand, stripAnsi, localUrls, type Manager } from "./detect.js";

/** One line in the log view. */
export interface LogLine {
  id: number;
  ts: number;
  text: string;
  /** "err" is stderr, which many tools use for ordinary progress — coloured, not alarmed. */
  kind: "out" | "err" | "deck";
}

export interface Run {
  /** The procStream id, and this run's handle everywhere. */
  id: string;
  /** The folder holding the package.json. */
  cwd: string;
  /** The package's name, for labelling; may be empty. */
  pkg: string;
  script: string;
  pm: Manager;
  status: "running" | "stopping" | "ended";
  /** Exit code once ended; null while running or when it was stopped. */
  code: number | null;
  /** Local addresses the script printed, in the order they appeared — a dev server's URL. */
  urls: string[];
  log: LogLine[];
}

/** Lines kept per run. A watcher prints a lot; past a few thousand the view is the bottleneck. */
const MAX_LOG = 5000;

const runs = new Map<string, Run>();
const subs = new Set<() => void>();
let lineSeq = 0;

/** A snapshot for useSyncExternalStore. Rebuilt on change so identity comparison works. */
let snapshot: Run[] = [];
let publishTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Tell the panel something changed, at most ten times a second.
 *
 * Called per output line, and each call re-rendered the whole log (up to MAX_LOG rows): a chatty
 * process printing hundreds of lines a second kept the main thread busy for as long as it lasted.
 * A tenth of a second is still live to read, and a burst of any size costs ten renders a second.
 */
const publish = () => {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    snapshot = [...runs.values()];
    subs.forEach((f) => f());
    publishState();
  }, 100);
};

/**
 * Publish the runs to a config file, so the MCP tools can read them — the webview is the only
 * place they exist.
 *
 * Debounced, because every config write wakes every `config-changed` listener in Deck, and a
 * watcher can print hundreds of lines a minute. The log is cut short: the file answers "did it
 * start, did it fail", and the last couple of hundred lines carry that.
 */
const STATE_KEY = "plugin-npm-runs";
const STATE_LOG_LINES = 200;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

function publishState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const payload = {
      runs: [...runs.values()].map((r) => ({
        id: r.id, cwd: r.cwd, pkg: r.pkg, script: r.script, pm: r.pm,
        status: r.status, code: r.code, urls: r.urls,
        log: r.log.slice(-STATE_LOG_LINES).map((l) => ({ ts: l.ts, kind: l.kind, text: l.text })),
      })),
    };
    void configWrite(STATE_KEY, JSON.stringify(payload)).catch((e) => console.warn("[npm] run state save failed", e));
  }, 500);
}

// A fresh webview has no runs and the file still holds the last session's; an agent reading it
// would report servers that died with the previous window.
void configWrite(STATE_KEY, JSON.stringify({ runs: [] })).catch((e) => console.warn("[npm] run state save failed", e));

export const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export const getRuns = () => snapshot;

function append(run: Run, text: string, kind: LogLine["kind"]) {
  run.log.push({ id: ++lineSeq, ts: Date.now(), text, kind });
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
}

/**
 * One subscription for every run. `proc-line` carries every process Deck streams — the Flutter
 * plugin's apps and the music plugin's downloads too — so the id lookup is what keeps them apart.
 */
let wired: Promise<void> | null = null;
function wire() {
  if (wired) return wired;
  wired = listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    const run = runs.get(e.payload.id);
    if (!run) return;
    const text = stripAnsi(e.payload.line);
    for (const url of localUrls(text)) if (!run.urls.includes(url)) run.urls.push(url);
    append(run, text, e.payload.stream === "stderr" ? "err" : "out");
    publish();
  }).then(() => {});
  return wired;
}

/** Start a script and stream it. Resolves with the run id once it is spawned. */
export async function start(cwd: string, pkg: string, script: string, pm: Manager): Promise<string> {
  await wire();
  const id = `npm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const run: Run = { id, cwd, pkg, script, pm, status: "running", code: null, urls: [], log: [] };
  runs.set(id, run);
  append(run, `${pm} run ${script}`, "deck");
  publish();

  const { program, args } = runCommand(pm, script);
  // Not awaited: this resolves when the script EXITS, which for a dev server is the session.
  void procStream(id, program, args, cwd)
    .then((r) => {
      run.status = "ended";
      run.code = r.cancelled ? null : r.code;
      append(run, r.cancelled ? "stopped" : `exited with code ${r.code}`, "deck");
      publish();
    })
    .catch((e) => {
      run.status = "ended";
      append(run, `could not start: ${String(e)}`, "deck");
      publish();
    });
  return id;
}

/**
 * Stop a script. procKill takes the whole process tree — cmd, the manager, and whatever the
 * script itself spawned (vite, nodemon's child) — so nothing is left holding the port.
 */
export function stop(id: string) {
  const run = runs.get(id);
  if (!run || run.status === "ended") return;
  run.status = "stopping";
  publish();
  void procKill(id).catch((e) => console.warn("[npm] stop failed", e));
}

/**
 * Run the same script again, as a new run, and drop the old one once the new one exists — so the
 * view never flashes empty in between. Waits for the old one to end first, or a dev server would
 * find its own port still taken.
 */
export async function restart(id: string): Promise<string | null> {
  const run = runs.get(id);
  if (!run) return null;
  if (run.status !== "ended") {
    stop(id);
    for (let i = 0; i < 50 && runs.get(id)?.status !== "ended"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const next = await start(run.cwd, run.pkg, run.script, run.pm);
  dismiss(id);
  return next;
}

/** Empty a run's log without touching the process. */
export function clearLog(id: string) {
  const run = runs.get(id);
  if (!run) return;
  run.log = [];
  publish();
}

/** Forget an ended run. */
export function dismiss(id: string) {
  const run = runs.get(id);
  if (run && run.status !== "ended") return;
  runs.delete(id);
  publish();
}

/**
 * Commands from the MCP tools, through Deck's HTTP API and a `plugin-command` event. The event is
 * broadcast to every plugin, so the name check is required.
 */
const unCommand = listen<{ plugin: string; op: string; args: Record<string, unknown> }>("plugin-command", (e) => {
  const { plugin, op, args } = e.payload;
  if (plugin !== "npm") return;
  const id = typeof args?.id === "string" ? args.id : "";
  switch (op) {
    case "start": {
      const pm = String(args?.pm ?? "npm");
      void start(
        String(args?.cwd ?? ""),
        String(args?.pkg ?? ""),
        String(args?.script ?? ""),
        (["npm", "pnpm", "yarn", "bun"].includes(pm) ? pm : "npm") as Manager,
      );
      break;
    }
    case "stop": stop(id); break;
    case "restart": void restart(id); break;
  }
});

/** Stop listening for MCP commands. The plugin's `dispose` calls this before Deck re-imports it,
 *  or one MCP command would start a run in every copy of the plugin a reload left behind. */
export function dispose() {
  void unCommand.then((un) => un()).catch(() => {});
  clearTimeout(publishTimer);
}

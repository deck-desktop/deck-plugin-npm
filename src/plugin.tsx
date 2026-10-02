// Scripts: run a package.json script, watch its output, stop or restart it from the footer.
//
// The Flutter plugin's shape, for the other half of most projects. TWO KINDS OF RUN, both
// deliberately:
//
//   plugin — started from here. Deck owns the process: the log is kept here, a dev server's
//            address is picked out of it, and stop takes the whole process tree.
//   pane   — `npm run dev` typed in a terminal. Recognised from Deck's process sweep and driven
//            by keystrokes (Ctrl+C), since that is all a terminal takes. Its output stays in the
//            terminal; the panel offers a jump to it rather than a second copy.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Play, Square, RotateCw, X, Copy, Trash2, WrapText, Package, TerminalSquare, ExternalLink, Loader2,
} from "lucide-react";
import { configRead, fsList, fsRead, openExternal } from "../shim/bridge.js";
import {
  termWrite, getLayout, useLayout, focusPane, paneLocation, switchWorkspace, type Layout,
} from "../shim/terminals.js";
import { ContextMenu, type MenuEntry } from "../shim/ui.js";
import {
  parsePackage, packageManager, scriptRun, shouldDescend, ownerWorkspace, packageLabel,
  typedCommand, type Manager, type PaneProcs,
} from "./detect.js";
import * as store from "./store.js";

// ---- the packages in a workspace -----------------------------------------------------------------

/** A package.json with scripts, and how to run them. */
interface Pkg { dir: string; name: string; scripts: Record<string, string>; pm: Manager }

/**
 * Every package with scripts in a workspace: its own folder and any nested under it — a
 * monorepo's apps/* and packages/*, or a frontend kept beside a backend.
 *
 * Breadth-first to a fixed depth, skipping node_modules and build output (see shouldDescend).
 * ponytail: depth 3 and a cap on folders visited bound the cost on a huge tree; a package deeper
 * than that is not offered, and the fix is raising MAX_DEPTH, not a smarter walk.
 *
 * Cached per workspace folder because `panelWhen` is synchronous and runs on every footer render.
 * The picker re-scans each time it opens, so a script added mid-session appears there.
 */
const pkgCache = new Map<string, Pkg[]>();
const MAX_DEPTH = 3;
const MAX_DIRS = 400;

async function scanPackages(root: string): Promise<Pkg[]> {
  if (!root) return [];
  // Every folder's file names, kept so a package can look UP for its workspace's lockfile.
  const names = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const found: Omit<Pkg, "pm">[] = [];
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && level.length && visited < MAX_DIRS; depth++) {
    const next: string[] = [];
    await Promise.all(level.map(async (dir) => {
      visited++;
      let entries: { name: string; path: string; dir: boolean }[] = [];
      try { entries = await fsList(dir); } catch { return; }
      names.set(dir, entries.filter((e) => !e.dir).map((e) => e.name));
      if (entries.some((e) => !e.dir && e.name === "package.json")) {
        try {
          const p = parsePackage(await fsRead(`${dir}/package.json`));
          if (p) found.push({ dir, ...p });
        } catch { /* unreadable: not offered */ }
      }
      for (const e of entries) {
        if (e.dir && shouldDescend(e.name)) { next.push(e.path); parent.set(e.path, dir); }
      }
    }));
    level = next;
  }
  const pkgs = found.map((p) => {
    const up: string[][] = [];
    for (let d: string | undefined = p.dir; d; d = parent.get(d)) up.push(names.get(d) ?? []);
    return { ...p, pm: packageManager(up) };
  });
  // The root first, then the rest by path, so the menu is in the same order every time.
  pkgs.sort((a, b) => (a.dir === root ? -1 : b.dir === root ? 1 : a.dir.localeCompare(b.dir)));
  pkgCache.set(root, pkgs);
  return pkgs;
}

const packagesIn = (root: string) => {
  const seen = pkgCache.get(root);
  return seen ? Promise.resolve(seen) : scanPackages(root);
};

/** The active workspace's directory, read straight from the layout store. */
function currentCwd(): string {
  const l = getLayout();
  return l?.workspaces.find((w) => w.id === l.activeWs)?.cwd ?? "";
}

// ---- runs, of both kinds, for the active workspace -------------------------------------------

const useRuns = () => useSyncExternalStore(store.subscribe, store.getRuns);

/**
 * The runs whose folder sits in the active workspace, plus any no workspace claims — an agent
 * can start one anywhere, and a run nobody can see is one nobody can stop.
 */
function runsHere(runs: store.Run[], l: Layout | null): store.Run[] {
  if (!l) return runs;
  return runs.filter((r) => {
    const owner = ownerWorkspace(l.workspaces, r.cwd);
    return owner === null || owner === l.activeWs;
  });
}

/** A script someone started in a terminal pane. */
interface PaneRun { paneId: string; wsId: string; label: string; pm: Manager; script: string }

/** The workspace and a readable label for a pane. */
function paneInfo(l: Layout | null, id: string): { wsId: string; label: string } | null {
  if (!l) return null;
  for (const w of l.workspaces) {
    for (const t of w.tabs) {
      const walk = (n: typeof t.root): string | null =>
        n.kind === "leaf" ? (n.id === id ? (n.label || t.title) : null) : (walk(n.a) ?? walk(n.b));
      const hit = walk(t.root);
      if (hit) return { wsId: w.id, label: hit };
    }
  }
  return null;
}

/** Every terminal pane running a script, from Deck's process sweep. */
async function findPaneRuns(l: Layout | null): Promise<PaneRun[]> {
  let procs: PaneProcs = {};
  try {
    const t = await configRead("term-procs");
    procs = t.trim() ? (JSON.parse(t) as PaneProcs) : {};
  } catch { return []; }
  const out: PaneRun[] = [];
  for (const [paneId, rows] of Object.entries(procs)) {
    const info = paneInfo(l, paneId);
    // One row per pane even when a script started another manager underneath (a root `dev`
    // that runs `pnpm --filter web dev`): the outermost is the one that was typed.
    const hit = rows.map(scriptRun).find(Boolean);
    if (hit) out.push({ paneId, wsId: info?.wsId ?? "", label: info?.label ?? "terminal", ...hit });
  }
  return out;
}

/**
 * The pane runs, polled at the sweep's own interval — Deck rewrites term-procs every 10s, so
 * reading it faster only re-reads the same answer. Shared by the drawer and the footer through
 * one module-level poll, so two mounted views do not double the reads.
 */
const POLL_MS = 10_000;
let paneRuns: PaneRun[] = [];
const paneSubs = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
function pollPanes() {
  void findPaneRuns(getLayout()).then((r) => {
    if (JSON.stringify(r) === JSON.stringify(paneRuns)) return;
    paneRuns = r;
    paneSubs.forEach((f) => f());
  });
}
function subscribePanes(fn: () => void) {
  paneSubs.add(fn);
  if (!pollTimer) { pollPanes(); pollTimer = setInterval(pollPanes, POLL_MS); }
  return () => {
    paneSubs.delete(fn);
    if (!paneSubs.size) { clearInterval(pollTimer); pollTimer = undefined; }
  };
}
const usePaneRuns = () => useSyncExternalStore(subscribePanes, () => paneRuns);

/** Show a pane: its workspace and tab, the Workspaces module, then focus once it has mounted. */
function jumpToPane(paneId: string) {
  const loc = paneLocation(paneId);
  if (!loc) return;
  switchWorkspace(loc.wsId, loc.tabId);
  window.dispatchEvent(new CustomEvent("deck-navigate", { detail: "terminals" }));
  let tries = 0;
  const tick = () => { if (!focusPane(paneId) && ++tries < 20) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

/**
 * Stop or restart a terminal run with keystrokes. Ctrl+C ends it; a restart types the command
 * back once the shell has its prompt again.
 *
 * ponytail: a fixed wait for the prompt, not a check for it. Under cmd.exe a .cmd shim asks
 * "Terminate batch job (Y/N)?" and the retyped command answers it instead — PowerShell, Deck's
 * default shell, runs the managers' .ps1 shims and never asks.
 */
function paneStop(r: PaneRun) { void termWrite(r.paneId, "\x03").catch(() => {}); }
function paneRestart(r: PaneRun) {
  paneStop(r);
  setTimeout(() => { void termWrite(r.paneId, `${typedCommand(r.pm, r.script)}\r`).catch(() => {}); }, 1200);
}

// ---- the picker -------------------------------------------------------------------------------

/**
 * Pick a script to run. With one package, the menu is its scripts; with several, each package is
 * a row whose submenu holds its scripts.
 *
 * Deck's own ContextMenu, which flips and clamps to the window — the button sits in the footer
 * at the bottom of the window and in a pane that may be at the top.
 */
function ScriptPicker({ root, running, onPick, children, title = "Run a script" }: {
  root: string;
  /** "dir\0script" for every script already running here, to mark them in the menu. */
  running: Set<string>;
  onPick: (p: Pkg, script: string) => void;
  children: React.ReactNode;
  title?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!at) return;
    let alive = true;
    setPkgs(pkgCache.get(root) ?? null);
    void scanPackages(root).then((p) => { if (alive) setPkgs(p); });
    return () => { alive = false; };
  }, [at !== null, root]);

  const toggle = () => {
    if (at || !anchor.current) { setAt(null); return; }
    const r = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setAt({ x: r.right, y: below >= r.top ? r.bottom + 4 : r.top - 4 });
  };

  const scriptItems = (p: Pkg): MenuEntry[] => Object.entries(p.scripts).map(([name, body]) => ({
    label: name,
    subLabel: body,
    dot: running.has(`${p.dir}\0${name}`) ? ("ok" as const) : undefined,
    onClick: () => { setAt(null); onPick(p, name); },
  }));

  const items: MenuEntry[] =
    pkgs === null ? [{ label: "Reading package.json…", disabled: true }]
    : !pkgs.length ? [{ label: "No package.json with scripts here", disabled: true }]
    : pkgs.length === 1 ? scriptItems(pkgs[0])
    : pkgs.map((p) => ({
        label: packageLabel(root, p.dir, p.name),
        // The folder under the name, since a package's name rarely says where it lives.
        subLabel: [packageLabel(root, p.dir, ""), p.pm === "npm" ? "" : p.pm].filter(Boolean).join(" · "),
        icon: Package,
        children: scriptItems(p),
      }));

  return (
    <>
      <button ref={anchor} onClick={toggle} onMouseDown={(e) => e.stopPropagation()} title={title}>
        {children}
      </button>
      {at && <ContextMenu x={at.x} y={at.y} alignRight items={items} onClose={() => setAt(null)} />}
    </>
  );
}

const runningKeys = (runs: store.Run[]) =>
  new Set(runs.filter((r) => r.status !== "ended").map((r) => `${r.cwd}\0${r.script}`));

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

const LOG_COLOR: Record<store.LogLine["kind"], string> = {
  out: "text-text-secondary",
  // stderr is where many tools put ordinary progress, so it is set apart, not painted as failure.
  err: "text-amber-300/90",
  deck: "text-emerald-400",
};

const runLabel = (r: { pkg: string; script: string }) => (r.pkg ? `${r.pkg} › ${r.script}` : r.script);

/**
 * What the panel looked like last time: the selected run, the filter and wrap. Per machine and
 * in localStorage, for the reason the Flutter panel gives — view state, not something to sync.
 */
const PREFS_KEY = "deck.npm.panel";
type Prefs = { selected: string | null; q: string; wrap: boolean };
const prefs: Partial<Prefs> = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>; }
  catch { return {}; }
})();

const iconBtn = "grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary";

// ---- the drawer panel, and the same thing as a pane -----------------------------------------------

export function Panel() {
  const layout = useLayout();
  const runs = runsHere(useRuns(), layout);
  const panes = usePaneRuns().filter((r) => r.wsId === layout?.activeWs);
  const wsCwd = layout?.workspaces.find((w) => w.id === layout.activeWs)?.cwd ?? "";
  const [selected, setSelected] = useState<string | null>(prefs.selected ?? null);
  const [q, setQ] = useState(prefs.q ?? "");
  const [wrap, setWrap] = useState(prefs.wrap ?? true);
  const [hasPkgs, setHasPkgs] = useState(false);

  useEffect(() => {
    let alive = true;
    void packagesIn(wsCwd).then((p) => { if (alive) setHasPkgs(p.length > 0); });
    return () => { alive = false; };
  }, [wsCwd]);

  useEffect(() => {
    Object.assign(prefs, { selected, q, wrap });
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* quota / private mode */ }
  }, [selected, q, wrap]);

  const active = runs.find((r) => r.id === selected) ?? runs[0] ?? null;
  const lines = active?.log ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines;

  // Follow the tail only when already at the bottom, so reading back is not yanked away.
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, active?.id]);

  // Ctrl+C on a selection: WebView2 has no application menu, so the native accelerator never fires.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
    const text = window.getSelection()?.toString();
    if (!text) return;
    e.preventDefault();
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const launch = (p: Pkg, script: string) => {
    void store.start(p.dir, p.name, script, p.pm).then(setSelected);
  };
  const picker = (children: React.ReactNode) => (
    <ScriptPicker root={wsCwd} running={runningKeys(runs)} onPick={launch}>{children}</ScriptPicker>
  );

  if (!runs.length && !panes.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
        <Package size={28} className="opacity-40" />
        <p className="text-sm">No script running.</p>
        {hasPkgs ? picker(
          <span className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 text-xs text-text-primary hover:bg-white/15">
            <Play size={12} /> Run a script
          </span>,
        ) : (
          <p className="text-xs">No package.json with scripts in this workspace.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* The runs, and the controls for the selected one. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-subtle px-2 py-1.5">
        {runs.map((r) => (
          <button key={r.id} onClick={() => setSelected(r.id)}
            className={`flex flex-none items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
              r.id === active?.id ? "bg-white/10 text-text-primary" : "text-text-muted hover:bg-white/5"}`}>
            <span className={r.status === "running" ? "text-emerald-400"
              : r.status === "ended" && r.code ? "text-red-400" : "text-text-muted"}>
              {r.status === "running" ? "●" : r.status === "stopping" ? "◐" : "○"}
            </span>
            {runLabel(r)}
          </button>
        ))}
        {/* Terminal runs have no log here — it is in the terminal — so these jump to it. */}
        {panes.map((p) => (
          <button key={p.paneId} onClick={() => jumpToPane(p.paneId)}
            title={`${typedCommand(p.pm, p.script)} — running in the terminal "${p.label}". Click to go to it.`}
            className="flex flex-none items-center gap-1.5 rounded px-2 py-1 text-[11px] text-text-muted hover:bg-white/5 hover:text-text-primary">
            <TerminalSquare size={11} className="text-emerald-400" />
            {p.script}
            <span className="text-text-muted">· {p.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        {active?.urls.map((u) => (
          <button key={u} onClick={() => void openExternal(u).catch(() => {})} title={`Open ${u}`}
            className="flex flex-none items-center gap-1 rounded px-1.5 py-1 font-mono text-[10.5px] text-sky-300 hover:bg-white/10">
            {u.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            <ExternalLink size={10} />
          </button>
        ))}
        {active && active.status !== "ended" && (
          <>
            <button onClick={() => void store.restart(active.id).then((id) => id && setSelected(id))}
              title="Restart" className={iconBtn}>
              <RotateCw size={12} />
            </button>
            <button onClick={() => store.stop(active.id)} title="Stop"
              className={iconBtn + " hover:!text-red-400"}>
              {active.status === "stopping" ? <Loader2 size={11} className="animate-spin" /> : <Square size={10} />}
            </button>
          </>
        )}
        {active?.status === "ended" && (
          <>
            <button onClick={() => void store.restart(active.id).then((id) => id && setSelected(id))}
              title={`Run ${active.script} again`} className={iconBtn}>
              <RotateCw size={12} />
            </button>
            <button onClick={() => store.dismiss(active.id)} title="Close this run" className={iconBtn}>
              <X size={12} />
            </button>
          </>
        )}
        {hasPkgs && picker(<span className={iconBtn}><Play size={12} /></span>)}
      </div>

      {active ? (
        <>
          <div className="flex items-center gap-1.5 border-b border-subtle px-2 py-1">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter output…"
              spellCheck={false}
              className="w-60 rounded border border-subtle bg-card px-2 py-0.5 font-mono text-[11px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-muted focus:border-accent-soft" />
            <span className="text-[10px] text-text-muted">
              {shown.length}{shown.length !== lines.length && ` / ${lines.length}`} lines
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <button onClick={() => setWrap((v) => !v)} title={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
                className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"
                style={wrap ? { color: "var(--text-primary)" } : undefined}>
                <WrapText size={12} />
              </button>
              <button onClick={() => void navigator.clipboard.writeText(shown.map((l) => l.text).join("\n")).catch(() => {})}
                title="Copy what is shown"
                className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary">
                <Copy size={12} />
              </button>
              <button onClick={() => store.clearLog(active.id)} title="Clear the output"
                className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary">
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <div ref={logRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown}
            className={`scroll-thin flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-[1.5] outline-none ${
              wrap ? "" : "overflow-x-auto"}`}>
            {shown.map((l) => (
              <div key={l.id}
                className={`flex gap-2 px-1 hover:bg-white/5 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
                <span className="shrink-0 text-text-muted">{time(l.ts)}</span>
                <span className={`min-w-0 flex-1 ${LOG_COLOR[l.kind]}`}>{l.text}</span>
              </div>
            ))}
            {!shown.length && (
              <div className="px-1 py-3 text-text-muted">
                {lines.length ? "Nothing matches this filter." : "Waiting for output…"}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
          Running in a terminal — its output is there. Click it above to go to it.
        </div>
      )}
    </div>
  );
}

// ---- the footer readout ---------------------------------------------------------------------------

/**
 * What is running here, with stop and restart for it, from any module. A ▶ when nothing is.
 *
 * Acts on the first run when several are going; the drawer is where you pick among them, and the
 * label opens it.
 */
export function Status() {
  const layout = useLayout();
  const runs = runsHere(useRuns(), layout).filter((r) => r.status !== "ended");
  const panes = usePaneRuns().filter((r) => r.wsId === layout?.activeWs);
  const wsCwd = layout?.workspaces.find((w) => w.id === layout.activeWs)?.cwd ?? "";
  const [hasPkgs, setHasPkgs] = useState(false);

  // Asked even while something runs: the answer also decides whether the drawer tab shows, and
  // panelWhen reads it from the cache this fills.
  useEffect(() => {
    let alive = true;
    void packagesIn(wsCwd).then((p) => { if (alive) setHasPkgs(p.length > 0); });
    return () => { alive = false; };
  }, [wsCwd]);

  const total = runs.length + panes.length;
  if (!total) {
    return hasPkgs ? (
      <ScriptPicker root={wsCwd} running={new Set()}
        onPick={(p, s) => { void store.start(p.dir, p.name, s, p.pm); }}>
        <span className="grid h-6 w-6 place-items-center rounded text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary">
          <Play size={12} />
        </span>
      </ScriptPicker>
    ) : null;
  }

  const run = runs[0];
  const pane = run ? undefined : panes[0];
  const name = run ? run.script : pane!.script;
  const openDrawer = () => window.dispatchEvent(new CustomEvent("deck-footer-tab", { detail: "plugin:npm" }));

  return (
    <div className="flex items-center gap-0.5">
      <button onClick={openDrawer}
        title={total > 1 ? `${total} scripts running — open the list` : `${name} — show its output`}
        className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-text-secondary hover:bg-white/10 hover:text-text-primary">
        <span className="text-emerald-400">●</span>
        {name}{total > 1 && <span className="text-text-muted">+{total - 1}</span>}
      </button>
      <button title="Restart"
        onClick={() => { if (run) void store.restart(run.id); else if (pane) paneRestart(pane); }}
        className={iconBtn}>
        <RotateCw size={12} />
      </button>
      <button title="Stop"
        onClick={() => { if (run) store.stop(run.id); else if (pane) paneStop(pane); }}
        className={iconBtn + " hover:!text-red-400"}>
        <Square size={10} />
      </button>
    </div>
  );
}

/** The lucide icon for the drawer tab. */
export const panelIcon = "Package";

/**
 * Whether the drawer tab shows: something runs here, or the workspace has scripts to run.
 * Synchronous and asked on every footer render, so it reads the caches the readout fills.
 */
export const panelWhen = () => {
  const l = getLayout();
  return runsHere(store.getRuns(), l).length > 0
    || paneRuns.some((r) => r.wsId === l?.activeWs)
    || (pkgCache.get(currentCwd())?.length ?? 0) > 0;
};

/**
 * Palette entries: one per script in this workspace, plus stop and restart for what is running.
 * Built from the cache, which the footer readout keeps filled for the active workspace.
 */
export function commands() {
  const l = getLayout();
  const root = currentCwd();
  const pkgs = pkgCache.get(root) ?? [];
  const live = runsHere(store.getRuns(), l).filter((r) => r.status !== "ended");
  return [
    ...pkgs.flatMap((p) => Object.keys(p.scripts).map((s) => ({
      id: `run:${p.dir}:${s}`,
      title: `Run script: ${pkgs.length > 1 ? `${packageLabel(root, p.dir, p.name)} › ` : ""}${s}`,
      run: () => { void store.start(p.dir, p.name, s, p.pm); },
    }))),
    ...live.flatMap((r) => [
      { id: `stop:${r.id}`, title: `Stop script: ${runLabel(r)}`, run: () => store.stop(r.id) },
      { id: `restart:${r.id}`, title: `Restart script: ${runLabel(r)}`, run: () => { void store.restart(r.id); } },
    ]),
  ];
}

/** The same view as a pane in the Terminals split tree, for keeping a server's output in place. */
export const PaneView = Panel;

// The runs started from here, as rows under their project in Deck's workspace sidebar (its sidebar
// API, beside the project's agents): a dev server with its address, or a run's state. A click opens
// the Scripts panel on its log; a right-click restarts or stops it.
import { openExternal } from "../shim/bridge.js";
import { setSidebarRows, type SidebarRow } from "../shim/sidebar.js";
import * as store from "./store.js";

/** Asks the panel (plugin.tsx) to show a run, by id. */
export const SELECT_RUN = "deck-npm-select-run";

const stateOf = (r: store.Run): SidebarRow["status"] =>
  r.status === "running" ? { text: "running", tone: "ok" }
  : r.status === "stopping" ? { text: "stopping", tone: "muted" }
  : r.code ? { text: `exited ${r.code}`, tone: "bad" }
  : { text: r.code === 0 ? "done" : "stopped", tone: "muted" };

const openLog = (r: store.Run) => {
  window.dispatchEvent(new CustomEvent(SELECT_RUN, { detail: r.id }));
  window.dispatchEvent(new CustomEvent("deck-footer-tab", { detail: "plugin:npm" }));
};

const restart = (r: store.Run) => { void store.restart(r.id).catch((e) => console.warn("[npm] restart failed", e)); };

// What can be done to it from the sidebar: what the panel's buttons do, while it runs or once it has ended.
const menuOf = (r: store.Run): SidebarRow["menu"] => [
  { label: "Open log", onClick: () => openLog(r) },
  ...(r.status === "running" && r.urls[0] ? [{ label: "Open in browser", onClick: () => { void openExternal(r.urls[0]).catch((e) => console.warn("[npm] open failed", e)); } }] : []),
  "sep",
  ...(r.status === "ended"
    ? [{ label: "Run again", onClick: () => restart(r) }, { label: "Close", onClick: () => store.dismiss(r.id) }]
    : [{ label: "Restart", onClick: () => restart(r), disabled: r.status === "stopping" },
       { label: "Stop", onClick: () => store.stop(r.id), danger: true, disabled: r.status === "stopping" }]),
];

const rowOf = (r: store.Run): SidebarRow => ({
  id: r.id, cwd: r.cwd,
  // U+FE0E: the triangle as text, not Windows' green emoji tile.
  icon: { text: "▶︎", color: "rgb(var(--tone-green-400))" },
  label: r.pkg || r.script, detail: r.pkg ? r.script : undefined,
  // Its address while it serves; once it has stopped, what became of it.
  url: r.status === "running" ? r.urls[0] : undefined,
  status: stateOf(r),
  title: `${r.pkg ? `${r.pkg} › ` : ""}${r.script}\n${r.cwd}`,
  onClick: () => openLog(r),
  menu: menuOf(r),
});

// A Deck from before the sidebar module has none: the rows are simply not shown there.
const publish = () => { try { setSidebarRows(store.getRuns().map(rowOf)); } catch { /* no sidebar module */ } };
const un = store.subscribe(publish);
publish();

/** Stop publishing, for the plugin's dispose (Deck drops the rows itself on a reload too). */
export function disposeSidebar() { un(); }

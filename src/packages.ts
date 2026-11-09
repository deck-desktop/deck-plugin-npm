// The packages with scripts in a workspace, found by a bounded walk and cached per folder.
// Moved out of plugin.tsx unchanged.
import { fsList, fsRead } from "../shim/bridge.js";
import { parsePackage, packageManager, shouldDescend, type Manager } from "./detect.js";

// ---- the packages in a workspace -----------------------------------------------------------------

/** A package.json with scripts, and how to run them. */
export interface Pkg { dir: string; name: string; scripts: Record<string, string>; pm: Manager }

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
export const pkgCache = new Map<string, Pkg[]>();
const MAX_DEPTH = 3;
const MAX_DIRS = 400;

export async function scanPackages(root: string): Promise<Pkg[]> {
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

export const packagesIn = (root: string) => {
  const seen = pkgCache.get(root);
  return seen ? Promise.resolve(seen) : scanPackages(root);
};

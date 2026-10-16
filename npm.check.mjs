// node npm.check.mjs
//
// The plain string logic behind the Scripts plugin. Each piece has one quiet way to be wrong:
//
//   scriptRun       — the terminal sweep sees node.exe running npm-cli.js, vite.js, and a
//                     language server; matching loosely puts stop buttons on the wrong pane, and
//                     matching the script's own children would report one run three times.
//   packageManager  — a package inside a pnpm workspace has no lockfile of its own; running it
//                     with npm instead ignores the workspace's links.
//   localUrls       — a dev server prints its LAN address too; the one to open here is loopback.
//
// Compiled from the real source with esbuild rather than restated, so this fails when it changes.
import assert from "node:assert";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/detect.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const d = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

// ---- recognising a script typed in a terminal --------------------------------------------------
// Real command lines, as Deck's sweep reports them.
const NPM = String.raw`"C:\Program Files\nodejs\\node.exe"  "C:\Users\me\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js" run dev`;
assert.deepEqual(d.scriptRun({ name: "node.exe", cmd: NPM }), { pm: "npm", script: "dev" });
assert.deepEqual(
  d.scriptRun({ name: "node.exe", cmd: String.raw`node C:/x/npm/bin/npm-cli.js start` }),
  { pm: "npm", script: "start" }, "npm start is a script");
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:/x/npm/bin/npm-cli.js install` }), null,
  "npm install is npm's own command");
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:/x/npm/bin/npm-cli.js explore lodash` }), null,
  "npm runs a script only through run, start or test — unlike pnpm and yarn");
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:/x/npm/bin/npm-cli.js run` }), null,
  "`npm run` alone lists scripts, it runs none");

// The script's body is NOT a run of its own: one `npm run dev` is three processes.
assert.equal(d.scriptRun({ name: "cmd.exe", cmd: String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c vite` }), null);
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`"node" "D:\app\node_modules\.bin\\..\vite\bin\vite.js"` }), null);
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:\npm\node_modules\intelephense\lib\intelephense.js --stdio` }), null,
  "a language server is node too");

// pnpm and yarn run a script without `run`, and take flags with values before it.
assert.deepEqual(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:\pnpm\bin\pnpm.cjs dev` }), { pm: "pnpm", script: "dev" });
assert.deepEqual(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:\pnpm\bin\pnpm.cjs --filter web dev` }),
  { pm: "pnpm", script: "dev" }, "the filter's value is not the script");
assert.equal(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:\pnpm\bin\pnpm.cjs install` }), null);
assert.deepEqual(d.scriptRun({ name: "node.exe", cmd: String.raw`node C:\yarn\bin\yarn.js run build` }), { pm: "yarn", script: "build" });
assert.deepEqual(d.scriptRun({ name: "bun.exe", cmd: "bun run dev" }), { pm: "bun", script: "dev" });
assert.equal(d.scriptRun({ name: "bun.exe", cmd: "bun index.ts" }), null, "bun running a file is not a script");

// ---- which package manager ---------------------------------------------------------------------
assert.equal(d.packageManager([["package.json", "pnpm-lock.yaml"]]), "pnpm");
assert.equal(d.packageManager([["package.json"], ["package.json", "yarn.lock"]]), "yarn",
  "a workspace package uses the lockfile above it");
assert.equal(d.packageManager([["package.json", "package-lock.json"], ["pnpm-lock.yaml"]]), "npm",
  "the nearest lockfile wins");
assert.equal(d.packageManager([["package.json"]]), "npm", "no lockfile at all is npm");
assert.deepEqual(d.runCommand("pnpm", "dev"), { program: "cmd", args: ["/C", "pnpm", "run", "dev"] });

// ---- reading package.json ----------------------------------------------------------------------
assert.deepEqual(d.parsePackage('{"name":"web","scripts":{"dev":"vite","n":1}}'),
  { name: "web", scripts: { dev: "vite" } }, "a non-string script is dropped");
assert.equal(d.parsePackage('{"name":"lib"}'), null, "a package with no scripts is not offered");
assert.equal(d.parsePackage('{"scripts":{}}'), null);
assert.equal(d.parsePackage("not json"), null);

for (const n of ["node_modules", "dist", ".git", ".next", "template", "fixtures"]) {
  assert.ok(!d.shouldDescend(n), `${n} is never searched`);
}
assert.ok(d.shouldDescend("packages") && d.shouldDescend("apps"));

// ---- addresses in a dev server's output --------------------------------------------------------
assert.deepEqual(d.localUrls("  ➜  Local:   http://localhost:5173/"), ["http://localhost:5173/"]);
assert.deepEqual(d.localUrls("  ➜  Network: http://192.168.1.4:5173/"), [], "a LAN address is not offered");
assert.deepEqual(d.localUrls("listening on http://0.0.0.0:3000."), ["http://localhost:3000"],
  "0.0.0.0 cannot be opened, and trailing punctuation is not part of it");
assert.deepEqual(d.localUrls("\u001b[36mhttp://127.0.0.1:8000\u001b[39m"), ["http://127.0.0.1:8000"],
  "colour codes around it are not part of it");

// ---- whose run it is ---------------------------------------------------------------------------
const wss = [{ id: "a", cwd: String.raw`D:\code\shop` }, { id: "b", cwd: "D:/code/shop/admin" }];
assert.equal(d.ownerWorkspace(wss, String.raw`D:\code\shop\web`), "a");
assert.equal(d.ownerWorkspace(wss, "d:/code/shop/admin/ui"), "b", "the deepest workspace wins");
assert.equal(d.ownerWorkspace(wss, "D:/code/shopping"), null, "a shared prefix is not containment");

assert.equal(d.packageLabel(String.raw`D:\code\shop`, String.raw`D:\code\shop\apps\web`, ""), "apps/web");
assert.equal(d.packageLabel(String.raw`D:\code\shop`, String.raw`D:\code\shop\apps\web`, "@shop/web"), "@shop/web");

console.log("npm.check.mjs: all assertions passed");

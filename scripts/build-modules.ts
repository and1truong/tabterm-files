// Build the files module into two self-contained runtime artifacts under dist/:
//   src/index.tsx -> dist/modules/files/client.js   (ESM, react external)
//   server.ts     -> dist/modules/files/server.js   (ESM, --target bun)
//
// A single-module distillation of the tabterm host's scripts/build-modules.ts.
// Like the timer module, files imports no CSS and does no dynamic import(), so
// there is no CSS extraction and no code-splitting: each half is one flat file.
// (highlight.js, marked and lucide-react — used by the preview pane and tree —
// are plain JS deps, so they inline into client.js rather than being
// externalized.) Run from the repo root.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Force the production JSX runtime (react/jsx-runtime, not …/jsx-dev-runtime).
// Bun's transpiler picks dev-vs-prod automatic JSX from NODE_ENV, read once at
// process start — so setting process.env here is too late. The dev runtime emits
// a bare `react/jsx-dev-runtime` import the host import map doesn't map, which
// fails to resolve at runtime. If NODE_ENV isn't already production, re-exec this
// script once with it set so Bun.build() sees it from the start.
if (process.env.NODE_ENV !== "production") {
  const proc = Bun.spawn(["bun", "run", import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

const REPO = process.cwd();
const OUT = join(REPO, "dist", "modules", "files");
const CLIENT_SRC = join(REPO, "src", "index.tsx");
const SERVER_SRC = join(REPO, "server.ts");

// react/react-dom are provided by the host SPA at runtime (import map →
// host-shims), so the client bundle keeps them external. highlight.js, marked
// and lucide-react are not host-provided, so they stay bundled.
const CLIENT_EXTERNALS = ["react", "react-dom", "react/jsx-runtime", "zustand"];

// Compile this module's Tailwind utilities. The host's Tailwind only scans the
// host tree, so utility classes used *only* here are never emitted host-side. We
// run Tailwind over src/tailwind.css (theme + utilities, no preflight — the host
// owns the reset) and fold the result into client.js's self-injecting <style>.
async function buildTailwind(): Promise<string> {
  const input = join(REPO, "src", "tailwind.css");
  const out = join(OUT, "tailwind.tmp.css");
  const proc = Bun.spawn(
    ["bun", "x", "@tailwindcss/cli", "-i", input, "-o", out, "--minify"],
    { cwd: REPO, env: { ...process.env, NODE_ENV: "production" }, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[build] tailwind failed (exit ${code})`);
    process.exit(code || 1);
  }
  const css = readFileSync(out, "utf8");
  rmSync(out, { force: true });
  return css;
}

// A self-injecting prelude prepended to client.js: on module evaluation it appends
// one <style> with the module's compiled CSS, so client.js is self-styled with no
// host CSS wiring. Guarded so a second evaluation (e.g. HMR) doesn't duplicate it.
function cssPrelude(css: string): string {
  return `(function(){try{if(typeof document==="undefined")return;` +
    `if(document.getElementById("tabterm-files-styles"))return;` +
    `var s=document.createElement("style");s.id="tabterm-files-styles";` +
    `s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}catch(e){}})();\n`;
}

async function buildClient(): Promise<void> {
  const res = await Bun.build({
    entrypoints: [CLIENT_SRC],
    outdir: OUT,
    format: "esm",
    minify: true,
    external: CLIENT_EXTERNALS,
    splitting: false,
    naming: { entry: "client.js" },
  });
  if (!res.success) {
    console.error("[build] client failed:");
    for (const log of res.logs) console.error(log);
    process.exit(1);
  }
  // Fold the module's compiled Tailwind into client.js so it stays self-contained.
  const css = await buildTailwind();
  const out = join(OUT, "client.js");
  writeFileSync(out, cssPrelude(css) + readFileSync(out, "utf8"));
}

async function buildServer(): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "build", SERVER_SRC, "--outfile", join(OUT, "server.js"),
      "--format", "esm", "--target", "bun", "--minify"],
    { cwd: REPO, env: { ...process.env, NODE_ENV: "production" }, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[build] server failed (exit ${code})`);
    process.exit(code || 1);
  }
}

// Fresh output dir — drops stale artifacts from a previous build.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await buildClient();
await buildServer();

console.log(`[build] files → ${join("dist", "modules", "files")}/{client.js,server.js}`);

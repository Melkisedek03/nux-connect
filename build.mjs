// Build script: bundles the four extension components with esbuild and
// assembles the loadable extension folder in dist/.
// The end user never runs this; release ZIPs ship the built folder.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const OUT = "dist";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const common = {
  bundle: true,
  target: "es2022",
  logLevel: "info",
  sourcemap: false,
};

// Background service worker (ES module, per manifest "type": "module").
await build({
  ...common,
  entryPoints: ["src/background/index.ts"],
  outfile: `${OUT}/background.js`,
  format: "esm",
  platform: "browser",
});

// Page-world provider and content script (classic scripts).
await build({
  ...common,
  entryPoints: ["src/inpage/index.ts"],
  outfile: `${OUT}/inpage.js`,
  format: "iife",
  platform: "browser",
});
await build({
  ...common,
  entryPoints: ["src/content/index.ts"],
  outfile: `${OUT}/content.js`,
  format: "iife",
  platform: "browser",
});

// Popup and approval window (ES module scripts).
await build({
  ...common,
  entryPoints: ["src/popup/index.ts"],
  outfile: `${OUT}/popup.js`,
  format: "esm",
  platform: "browser",
});
await build({
  ...common,
  entryPoints: ["src/approval/index.ts"],
  outfile: `${OUT}/approval.js`,
  format: "esm",
  platform: "browser",
});

// Static files copied verbatim.
cpSync("src/manifest.json", `${OUT}/manifest.json`);
cpSync("src/popup/popup.html", `${OUT}/popup.html`);
cpSync("src/approval/approval.html", `${OUT}/approval.html`);
cpSync("src/icons", `${OUT}/icons`, { recursive: true });
cpSync("src/fonts", `${OUT}/fonts`, { recursive: true });

console.log("Build complete: dist/ is ready for Load unpacked.");

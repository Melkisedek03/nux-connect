// Build script: bundles the extension components with esbuild and
// assembles the loadable extension folder.
//
//   node build.mjs          Chrome/Chromium build -> dist/
//   node build.mjs firefox  Firefox build -> dist-firefox/
//
// Both builds share every source file. They differ only in the
// background context and the manifest:
// - Chrome runs the background as an ES-module service worker.
// - Firefox does not support extension background service workers
//   (Firefox bug 1573659); it runs the background as a
//   non-persistent event page declared with background.scripts. The
//   Firefox background is therefore bundled as a classic (IIFE)
//   script, and the Firefox manifest carries the Gecko extension id
//   instead of a service worker entry.
// The end user never runs this; release ZIPs ship the built folder.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const TARGETS = ["chrome", "firefox"];
const target = process.argv[2] ?? "chrome";
if (!TARGETS.includes(target)) {
  console.error(
    `Unknown build target: ${target} (expected chrome or firefox)`,
  );
  process.exit(1);
}

const isFirefox = target === "firefox";
const OUT = isFirefox ? "dist-firefox" : "dist";
const MANIFEST = isFirefox
  ? "src/manifest.firefox.json"
  : "src/manifest.json";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const common = {
  bundle: true,
  target: "es2022",
  logLevel: "info",
  sourcemap: false,
};

// Background: ES module service worker on Chrome (per manifest
// "type": "module"), classic script on the Firefox event page.
await build({
  ...common,
  entryPoints: ["src/background/index.ts"],
  outfile: `${OUT}/background.js`,
  format: isFirefox ? "iife" : "esm",
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
cpSync(MANIFEST, `${OUT}/manifest.json`);
cpSync("src/popup/popup.html", `${OUT}/popup.html`);
cpSync("src/approval/approval.html", `${OUT}/approval.html`);
cpSync("src/icons", `${OUT}/icons`, { recursive: true });
cpSync("src/fonts", `${OUT}/fonts`, { recursive: true });

console.log(
  isFirefox
    ? "Build complete: dist-firefox/ is ready to load via about:debugging."
    : "Build complete: dist/ is ready for Load unpacked.",
);

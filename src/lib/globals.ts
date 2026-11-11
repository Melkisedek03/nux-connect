// Global shims for extension contexts.
//
// Parts of the bitcoinjs-lib ecosystem still reference the Node.js
// `Buffer` global, which does not exist in a service worker or an
// extension page. The `buffer` package is the ecosystem-standard
// polyfill; it is installed on the global object here, before any other
// module in the bundle runs. Import this module first in every entry
// point that touches the key stack (background, popup, approval).

import { Buffer } from "buffer";

const globalScope = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof globalScope.Buffer === "undefined") {
  globalScope.Buffer = Buffer;
}

export {};

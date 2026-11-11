// Derivation verification harness (development only, never shipped).
//
// It proves that the key engine in src/lib/keys.ts derives the same
// addresses as a fully independent implementation (@scure/bip39 +
// @scure/bip32 with a hand-rolled HASH160 + bech32 encoding), and that
// the well-known BIP84 Bitcoin test vector still comes out exact
// through the shipped pipeline. It also runs the shipped bundle in a
// browser-like VM context (no Node Buffer global) to prove the stack
// works inside a Manifest V3 worker, and finally checks that the
// derived testnet address is accepted by the live testnet electrs.
//
// Run with: npm run verify:derivation

import { buildSync } from "esbuild";
import { HDKey } from "@scure/bip32";
import * as scureBip39 from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bech32 } from "@scure/base";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const failures = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${actual}`);
  if (!ok) {
    console.log(`      expected: ${expected}`);
    failures.push(label);
  }
}

const TEST_MNEMONIC = Array(11).fill("abandon").concat("about").join(" ");

// ---------------------------------------------------------------------------
// Bundle the shipped key engine.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "nux-verify-"));
const bundlePath = join(tmp, "keys.mjs");
buildSync({
  entryPoints: ["src/lib/keys.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: bundlePath,
  logLevel: "silent",
});
// keys.ts imports networks.ts by relative path; networks must be bundled too,
// which esbuild already handled via the entry's import graph. But keys.ts does
// not import globals; derivation in Node works because Node provides Buffer.
// The dynamic import goes through pathToFileURL: on Windows a bare absolute
// path ("C:\...") is rejected by the ESM loader, which requires a file:// URL.
const keys = await import(pathToFileURL(bundlePath).href);
const networks = {
  testnet: {
    id: "testnet", label: "Testnet", bech32Hrp: "tn", coinType: 1,
    pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef,
    electrsBaseUrl: "https://apinuxtest.taobot.org", dustLimit: 546, locked: false,
  },
  mainnet: {
    id: "mainnet", label: "Mainnet", bech32Hrp: "nu", coinType: 662,
    pubKeyHash: 0x35, scriptHash: 0x4b, wif: 0x57,
    electrsBaseUrl: "https://apinux.taobot.org", dustLimit: 546, locked: true,
  },
  bitcoinAnchor: {
    id: "mainnet", label: "Bitcoin anchor", bech32Hrp: "bc", coinType: 0,
    pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80,
    electrsBaseUrl: "", dustLimit: 546, locked: true,
  },
};

// ---------------------------------------------------------------------------
// Independent @scure implementation.
// ---------------------------------------------------------------------------
function scureAddress(mnemonic, { hrp, coinType, chain, index }) {
  const seed = scureBip39.mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(
    `m/84'/${coinType}'/0'/${chain}/${index}`,
  );
  if (!child.publicKey) throw new Error("scure: no public key");
  const program = ripemd160(sha256(child.publicKey));
  const words = [0, ...bech32.toWords(program)];
  return bech32.encode(hrp, words);
}

// ---------------------------------------------------------------------------
// 1. The BIP84 anchor vector through BOTH implementations.
// ---------------------------------------------------------------------------
// Test vectors taken verbatim from the BIP84 specification document.
// (A widely circulated address for this mnemonic, bc1qar0srrr..., comes
// from a different derivation context; the BIP's own vectors govern.)
const BTC_VECTORS = [
  { chain: 0, index: 0, expected: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" },
  { chain: 0, index: 1, expected: "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g" },
  { chain: 1, index: 0, expected: "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el" },
];
{
  const account = keys.deriveAccountPublic(TEST_MNEMONIC, networks.bitcoinAnchor);
  for (const vector of BTC_VECTORS) {
    check(
      `anchor BIP84: @scure chain ${vector.chain} index ${vector.index}`,
      scureAddress(TEST_MNEMONIC, {
        hrp: "bc", coinType: 0, chain: vector.chain, index: vector.index,
      }),
      vector.expected,
    );
    check(
      `anchor BIP84: shipped chain ${vector.chain} index ${vector.index}`,
      keys.deriveAddress(account, networks.bitcoinAnchor, vector.chain, vector.index),
      vector.expected,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Nusacoin networks: shipped vs independent, receive and change.
// ---------------------------------------------------------------------------
const derived = {};
for (const net of [networks.testnet, networks.mainnet]) {
  const account = keys.deriveAccountPublic(TEST_MNEMONIC, net);
  for (const chain of [0, 1]) {
    const shipped = keys.deriveAddress(account, net, chain, 0);
    const independent = scureAddress(TEST_MNEMONIC, {
      hrp: net.bech32Hrp, coinType: net.coinType, chain, index: 0,
    });
    check(
      `${net.id} chain ${chain} index 0: shipped == independent`,
      shipped,
      independent,
    );
    if (chain === 0) derived[net.id] = shipped;
  }
}

// ---------------------------------------------------------------------------
// 3. Browser-like VM: the shipped bundle (with the Buffer shim) must run
//    with no Node Buffer global present.
// ---------------------------------------------------------------------------
{
  const probeEntry = join(tmp, "probe-entry.ts");
  writeFileSync(
    probeEntry,
    [
      'import "../src/lib/globals";',
      'import { deriveAccountPublic, deriveAddress, generateMnemonicPhrase, isValidMnemonicPhrase } from "../src/lib/keys";',
      'import { TESTNET } from "../src/lib/networks";',
      "export function probe() {",
      "  const generated = generateMnemonicPhrase();",
      "  if (!isValidMnemonicPhrase(generated)) throw new Error('generated phrase invalid');",
      `  const account = deriveAccountPublic(${JSON.stringify(TEST_MNEMONIC)}, TESTNET);`,
      "  return deriveAddress(account, TESTNET, 0, 0);",
      "}",
    ].join("\n"),
  );
  // The probe entry lives in tmp; rewrite its relative imports to absolute
  // source paths so esbuild can resolve them. fileURLToPath (not .pathname)
  // keeps this correct on Windows, and forward slashes are used so the
  // rewritten import specifiers stay valid there too.
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url)).replaceAll("\\", "/");
  const probeSource = readFileSync(probeEntry, "utf8")
    .replaceAll("../src", srcRoot.replace(/\/$/, ""));
  writeFileSync(probeEntry, probeSource);
  const probeBundle = join(tmp, "probe.js");
  buildSync({
    entryPoints: [probeEntry],
    bundle: true,
    format: "iife",
    globalName: "Probe",
    platform: "browser",
    outfile: probeBundle,
    logLevel: "silent",
  });
  // The sandbox crypto comes from node:crypto explicitly: on some Node
  // versions the global WebCrypto object does not survive being copied
  // into a vm context, which made this step fail for harness reasons.
  const sandbox = {
    console, crypto: webcrypto, setTimeout, clearTimeout,
    TextEncoder, TextDecoder, atob, btoa, URL,
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(probeBundle, "utf8"), sandbox);
  if (typeof sandbox.Buffer !== "function") {
    // The shim inside the bundle defines its own Buffer; the sandbox global
    // stays undefined, which is exactly the worker situation.
  }
  check(
    "browser VM (no Buffer): shipped derivation",
    sandbox.Probe.probe(),
    derived.testnet,
  );
}

// ---------------------------------------------------------------------------
// 4. Live check: the derived testnet address is served by electrs testnet.
// ---------------------------------------------------------------------------
try {
  const res = await fetch(
    `${networks.testnet.electrsBaseUrl}/address/${derived.testnet}`,
  );
  check("live electrs testnet accepts the derived address (HTTP 200)",
    String(res.status), "200");
} catch (error) {
  console.log(`WARN  live electrs check skipped: ${error.message}`);
}

console.log(
  failures.length === 0
    ? "\nAll derivation checks passed."
    : `\n${failures.length} check(s) FAILED.`,
);
process.exit(failures.length === 0 ? 0 : 1);

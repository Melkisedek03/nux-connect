# NUX Connect

A browser extension wallet for [Nusacoin](https://github.com/TaobotX11/nusacoin) (NUX),
with a MetaMask-style interaction pattern adapted to the UTXO model.

**Status: specification phase.** The design is fully locked (see the documents
below); implementation has not started. Version one is a **demo dApp wallet**,
not a production wallet for significant funds.

## Locked direction

- **Testnet-first, mandatory.** The MVP runs on Nusacoin testnet. The mainnet
  configuration is prepared but locked, and is enabled only after the testnet
  completion criteria pass **and** a security audit is complete.
- **No build step for end users.** Releases ship as a ZIP containing a
  pre-built extension folder, installed via *Load unpacked* in the browser's
  developer mode. Development uses TypeScript with a light bundler.
- **No new backend.** The extension talks to the existing Nusacoin electrs
  (Esplora-style REST): testnet `https://apinuxtest.taobot.org`, mainnet
  `https://apinux.taobot.org`.
- **Library: bitcoinjs-lib** (battle-tested), with the Nusacoin network
  parameters supplied as a custom network configuration object — no library
  source modifications.

## Architecture

Manifest V3, four components with a narrow one-way data flow:

1. **Inpage provider** — exposes `window.nux` to web pages; holds no keys.
2. **Content script** — message bridge between the page and the extension.
3. **Background** — the vault, per-site permissions,
   transaction construction, and signing. It runs as a service worker
   on Chrome and as a non-persistent event page on Firefox; the code
   is shared, only the manifest entry and the bundle format differ.
4. **User interface** — a toolbar popup plus a separate approval window for
   every connection, payment, and signature request.

The provider follows the EIP-1193 pattern (`request`, Promises, events) with
eight methods: `nux_requestAccounts`, `nux_getAccounts`, `nux_getBalance`,
`nux_getNetwork`, `nux_sendTransaction`, `nux_signMessage`, `nux_signPsbt`,
`nux_sendPsbt`. All amounts are integer nusan (1 NUX = 100,000,000 nusan).
Private keys are never reachable from a web page; sites only ever receive
addresses, signatures, and transaction IDs.

## Network parameters

| Parameter | Mainnet | Testnet |
| --- | --- | --- |
| Bech32 HRP | `nu` | `tn` |
| Coin type (BIP44) | 662 | 1 (BIP44 testnet convention) |
| P2PKH / P2SH version | `0x35` / `0x4b` | `0x6f` / `0xc4` |
| WIF version | `0x57` | `0xef` |
| Receive path (BIP84) | `m/84'/662'/0'/0/<index>` | `m/84'/1'/0'/0/<index>` |
| Change path (BIP84) | `m/84'/662'/0'/1/<index>` | `m/84'/1'/0'/1/<index>` |
| Dust limit | 546 nusan | 546 nusan |

Derivation paths are documented explicitly and must never be guessed by an
implementer. The first derived mainnet address must exactly match the existing
web wallet for the same mnemonic — this is the primary conformance test.

## Key design decisions

- **Vault:** the mnemonic is stored only AES-GCM-encrypted under a
  password-derived key. While unlocked, only the vault decryption key is held
  in `chrome.storage.session` (trusted contexts only, RAM only), with a
  15-minute auto-lock enforced via `chrome.alarms`. Private keys are never
  stored; they are derived in memory at signing time.
- **Message signing** uses the legacy Nusacoin Core format exactly
  (`Nusacoin Signed Message:\n` magic, double-SHA256, recoverable compact
  signature, base64), so signatures cross-verify with Nusacoin Core
  `verifymessage` and the web wallet.
- **Origin gating:** every provider method, including read-only ones, answers
  only to connected origins. An unconnected site receives empty accounts /
  error 4100. Installing the extension grants a site no access by itself.
- **Confirmed balance** means ≥ 1 confirmation. **Fee guard:** dApp-supplied
  fee rates are accepted only within 1–546 nusan/vbyte; fee data always comes
  from the active network's own endpoint, never cross-network.
- **Incoming-coin notifications** are part of the MVP: periodic polling
  (`chrome.alarms`) against the active network's electrs, a browser
  notification that always names the network, a toolbar badge, and a popup
  activity list. A strict anti-change rule applies: a wallet's own change
  output never triggers an "incoming" notification.
- **PSBT (BIP174)** is the safe boundary for dApp-built transactions: the
  extension signs only its own inputs, recomputes every output and the fee,
  and rejects redirected change.

## Documents

- `docs/draf-nux-connect.md` — the full specification (Indonesian).
- `docs/draf-nux-connect-revisi-1.md` — Amendment "Revisi 1": ten locked
  decisions that complete and, where noted, supersede the specification
  (Indonesian).
- `docs/nux-connect-brief-tim.md` — project direction brief for the team
  (Indonesian).

## After the MVP

Lightning support is planned for a later phase, following the established
pattern in the Bitcoin ecosystem (the Alby model): the extension remains a
front-end and provider, the Lightning node runs outside the browser (a
user's ELNUX node or a hub), and the existing Nusacoin LSP provides
just-in-time channels. Lightning is not part of the MVP scope.

## Contributing

Work proceeds through pull requests. The locked decisions in the documents
above are not reopened in pull requests. Technical writing in this
repository is in English.

## Development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run build       # bundles the extension into dist/
npm run build:firefox  # Firefox build (event-page background) into dist-firefox/
npm run typecheck   # strict TypeScript check without emitting files
```

Load the result in Chrome, Brave, or Edge:

1. Open `chrome://extensions` (or the equivalent extensions page).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Click the NUX Connect toolbar icon: the popup shows the active
   network (testnet), the live chain tip height, and the current fee
   rate from the testnet electrs instance.

Firefox (desktop) uses the separate build above, because Firefox does
not support extension background service workers: its background is a
non-persistent event page instead. Load it temporarily via
`about:debugging` (Firefox 128 or later):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select any file inside the
   `dist-firefox/` folder (for example `manifest.json`).
3. The extension stays loaded until Firefox restarts. Permanent
   installation on regular Firefox requires a Mozilla-signed package
   (AMO self-distribution); that step is not part of this
   repository's build.

A provider smoke test page lives in `demo/`: serve that folder with any
static file server, open it, and use its buttons to detect `window.nux`
and call `nux_getNetwork`.

Repository layout:

- `src/background` — service worker: request routing, origin gating,
  status service.
- `src/content` — message bridge between page and extension.
- `src/inpage` — the `window.nux` provider.
- `src/popup`, `src/approval` — user interface windows.
- `src/lib` — network parameters, provider RPC types, electrs client.
- `docs/` — the specification and locked design decisions.

Milestone status: Milestones 1 (scaffold) and 2 (vault) are merged.
Milestone 2 adds the vault: BIP39 wallet creation and import, an
AES-GCM encrypted vault (PBKDF2-HMAC-SHA256, 600,000 iterations) whose
unlock key lives only in session storage, a 15-minute inactivity
auto-lock, address derivation for both networks, and balances in the
popup. Milestone 3 adds connection approvals: `nux_requestAccounts`
opens a dedicated approval window; approving records the origin in a
connected-origins store, answers with the accounts, and emits
`accountsChanged` to the origin's tabs, while rejecting or closing the
window settles the request with error 4001. The popup lists connected
sites and can disconnect them. Milestone 4 adds transactions and
signing: `nux_sendTransaction` builds payments from the wallet's
confirmed UTXOs (largest-first selection, dust change folded into the
fee) and broadcasts after approval; `nux_signMessage` signs in Nusacoin
Core's legacy format; `nux_signPsbt` and `nux_sendPsbt` sign PSBTs
after ownership and implied-fee-rate guard checks — each method behind
an approval window showing the exact details that will execute.
Milestone 5 adds the incoming-coin watcher: the 1-minute alarm polls
the watched receive addresses' UTXO lists (never a full discovery
scan, so the shared rate limiter stays calm), fires one "[TESTNET]
NUX masuk" system notification at mempool sighting, flips the popup
activity entry to confirmed at 1 confirmation with no second
notification, and never notifies for the wallet's own change (checked
against `vin.prevout`). The watcher runs while the vault is locked,
and a popup toggle (on by default) silences it.

A derivation verification harness cross-checks the key engine against
an independent implementation and the test vectors published in BIP84:

```bash
npm run verify:derivation
```

// Background service worker: the core of the extension.
//
// Responsibilities:
// - Route provider requests coming from content scripts, enforcing the
//   origin gating: read methods answer only for connected origins, and
//   account data is only exposed while the vault is unlocked.
// - Own user approvals. Every value-moving or signing method
//   (nux_requestAccounts, nux_sendTransaction, nux_signMessage,
//   nux_signPsbt, nux_sendPsbt) opens the approval window with an
//   exact, human-readable summary of what is being asked; only an
//   explicit approval there executes, records state, and answers.
//   Rejecting — or closing the window — settles the request with error
//   4001, as EIP-1193 prescribes.
// - Own the vault lifecycle (create, import, unlock, lock, auto-lock)
//   on behalf of the popup. Secrets never leave this context: the popup
//   receives the freshly generated mnemonic exactly once (at creation)
//   and addresses afterwards; signing keys are derived transiently from
//   the session-held mnemonic at approval time and never stored.
// - Fan provider events (accountsChanged, networkChanged) out to the
//   tabs an origin is known to run in. Events are a courtesy only:
//   every read is still gated against the stored state, so a missed
//   event can never leak an address.
// - Serve popup status: network, tip height, fee rate, and — when a
//   wallet exists — the primary address and its balances, the balances
//   from the persistent offline UTXO cache (synced from the active
//   network's own electrs instance in the background).

import "../lib/globals";
import {
  AddressBookError,
  addAddressBookEntry,
  listAddressBookEntries,
  removeAddressBookEntry,
} from "../lib/addressbook";
import {
  connectOrigin,
  disconnectOrigin as removeConnection,
  isOriginConnected,
  listConnections,
} from "../lib/connections";
import { ElectrsClient } from "../lib/electrs";
import { derivePrivateKey, primaryAddress } from "../lib/keys";
import { fetchMarketInfo, type MarketInfo } from "../lib/market";
import {
  getNetwork,
  readActiveNetworkId,
  writeActiveNetworkId,
  type NuxNetwork,
} from "../lib/networks";
import {
  ERROR_INVALID_PARAMS,
  ERROR_UNAUTHORIZED,
  ERROR_UNSUPPORTED_METHOD,
  ERROR_USER_REJECTED,
  ProviderRpcError,
  isKnownMethod,
  type ProviderRequest,
} from "../lib/rpc";
import {
  MAX_FEE_RATE,
  TxError,
  buildSendTransaction,
  finalizeToHex,
  maxSendable,
  signMessageLegacy,
  signWalletPsbt,
  summarizePsbt,
  type PsbtSummary,
  type SendDraft,
  type SendSummary,
} from "../lib/tx";
import {
  clearBadge,
  getActivityEntries,
  isNotificationsEnabled,
  runNotificationCheck,
  setNotificationsEnabled,
  updateWatchedAddresses,
} from "../lib/notifications";
import {
  VaultError,
  checkAutoLock,
  createVault,
  hasVault,
  importVault,
  isUnlocked,
  loadAccountPublics,
  lockVault,
  mnemonicFromSession,
  touchSession,
  unlockVault,
  type AccountPublics,
} from "../lib/vault";
import {
  currentReceiveAddress,
  nextUnusedReceiveIndex,
  readReceiveAddressIndex,
  writeReceiveAddressIndex,
} from "../lib/receiveaddress";
import {
  applyOwnBroadcast,
  readWalletCache,
  writeWalletCache,
  type WalletCacheRecord,
} from "../lib/walletcache";
import {
  discoverWallet,
  ownershipMap,
  type WalletState,
} from "../lib/wallet";
import {
  parseDisplayUnit,
  readDisplayUnit,
  writeDisplayUnit,
} from "../lib/units";

const POLL_ALARM = "nux-connect-poll";
const ERROR_SERVER = -32000;

/** The active network, from the stored user setting (testnet by
 * default). Callers that build from a client take their network
 * from the client instead, so a switch mid-operation cannot mix
 * one network's UTXOs into another network's transaction. */
async function activeNetwork(): Promise<NuxNetwork> {
  return getNetwork(await readActiveNetworkId());
}

/** Primary address of the wallet on the active network, if a vault exists. */
async function walletPrimaryAddress(): Promise<string | null> {
  const publics = await loadAccountPublics();
  if (!publics) return null;
  const network = await activeNetwork();
  return primaryAddress(publics[network.id], network);
}

/** Primary address of the wallet on one network, if a vault exists. */
async function walletPrimaryAddressOn(
  network: NuxNetwork,
): Promise<string | null> {
  const publics = await loadAccountPublics();
  if (!publics) return null;
  return primaryAddress(publics[network.id], network);
}

// ---------------------------------------------------------------------------
// Persistent offline UTXO cache (Milestone 9, PUNDI-style)
//
// A full discovery scan costs dozens of electrs requests, and building
// a send from a cold scan kept the popup on "Preparing…" for 10-40
// seconds with no feedback (field finding). The discovered wallet
// state — used addresses, confirmed UTXOs, first-unused change
// address, aggregated balances — is therefore kept in
// chrome.storage.local (see lib/walletcache.ts), where it survives
// browser restarts, and sends build from it immediately. Freshness
// comes from three directions: the 1-minute alarm refreshes the cache
// while the browser runs, status reads trigger a refresh when the
// record is stale, and every own broadcast updates the record
// optimistically. The selected inputs are verified against the network
// before signing, so a stale cache can delay a send but never cause a
// double-spend.

const WALLET_CACHE_STALE_MS = 60_000;

let walletSyncPromise: Promise<WalletCacheRecord> | null = null;

async function requireWalletPublics(network: NuxNetwork): Promise<{
  publics: AccountPublics;
  address: string;
}> {
  const publics = await loadAccountPublics();
  if (!publics) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  return { publics, address: primaryAddress(publics[network.id], network) };
}

/**
 * Full wallet sync: discovery + balance aggregation, written to the
 * persistent cache. Concurrent callers share one in-flight sync, so a
 * status read and an alarm tick never double-scan.
 */
async function syncWalletCache(
  client: ElectrsClient,
): Promise<WalletCacheRecord> {
  if (walletSyncPromise) return walletSyncPromise;
  walletSyncPromise = (async () => {
    try {
      const network = client.getNetwork();
      const { publics, address } = await requireWalletPublics(network);
      const state = await discoverWallet(
        client,
        publics[network.id],
        network,
      );
      // Unused addresses have zero history by definition, so they add
      // nothing; one info call per used address carries both balances.
      // The primary address alone misses change outputs — they land on
      // change-chain addresses — which once made the unconfirmed figure
      // show the whole spent input instead of the net outflow after a
      // send (field finding: a 8,000-nusan send from a 35,000-nusan
      // UTXO showed -35,000 instead of -8,280).
      let confirmed = 0;
      let unconfirmed = 0;
      for (const entry of state.addresses) {
        if (!entry.used) continue;
        const info = await client.getAddressInfo(entry.address);
        confirmed +=
          info.chainStats.fundedTxoSum - info.chainStats.spentTxoSum;
        unconfirmed +=
          info.mempoolStats.fundedTxoSum - info.mempoolStats.spentTxoSum;
      }
      let tipHeight = 0;
      try {
        tipHeight = await client.getTipHeight();
      } catch {
        const previous = await readWalletCache(network.id, address);
        tipHeight = previous?.tipHeight ?? 0;
      }
      const record: WalletCacheRecord = {
        syncedAt: Date.now(),
        tipHeight,
        state,
        confirmed,
        unconfirmed,
      };
      await writeWalletCache(network.id, address, record);
      // A fresh discovery refreshes the watcher's address list for free.
      void updateWatchedAddresses(state, network, address).catch(() => {});
      return record;
    } finally {
      walletSyncPromise = null;
    }
  })();
  return walletSyncPromise;
}

/**
 * Fire-and-forget cache refresh: syncs when the record is missing or
 * stale, shares the in-flight sync, never throws. Used by the alarm,
 * by status reads, and after an own broadcast.
 */
async function refreshWalletCacheInBackground(): Promise<void> {
  try {
    const network = await activeNetwork();
    const { address } = await requireWalletPublics(network);
    const cached = await readWalletCache(network.id, address);
    if (cached && Date.now() - cached.syncedAt < WALLET_CACHE_STALE_MS) {
      return;
    }
    await syncWalletCache(new ElectrsClient(network));
  } catch {
    // The next trigger retries; a failed refresh must never surface.
  }
}

/**
 * The wallet state, cache-first: the persistent record when present
 * (any age — staleness is handled by verification at send time and by
 * background refresh), a full sync only when no record exists.
 */
async function getWalletState(client: ElectrsClient): Promise<WalletState> {
  const network = client.getNetwork();
  const { address } = await requireWalletPublics(network);
  const cached = await readWalletCache(network.id, address);
  if (cached) return cached.state;
  const record = await syncWalletCache(client);
  return record.state;
}

/**
 * Aggregated balances, cache-first: the persistent record when
 * present (triggering a background refresh when stale), a full sync
 * only when no record exists.
 */
async function getCachedBalances(
  client: ElectrsClient,
): Promise<{ confirmed: number; unconfirmed: number }> {
  const network = client.getNetwork();
  const { address } = await requireWalletPublics(network);
  const cached = await readWalletCache(network.id, address);
  if (cached) {
    if (Date.now() - cached.syncedAt >= WALLET_CACHE_STALE_MS) {
      void refreshWalletCacheInBackground();
    }
    return { confirmed: cached.confirmed, unconfirmed: cached.unconfirmed };
  }
  const record = await syncWalletCache(client);
  return { confirmed: record.confirmed, unconfirmed: record.unconfirmed };
}

/** Optimistically apply an own broadcast to the persistent cache of
 * the network the transaction was built for — which may not be the
 * active network anymore if the user switched while the approval
 * was pending. */
async function applyBroadcastToCache(
  summary: SendSummary,
  network: NuxNetwork,
): Promise<void> {
  try {
    const { address } = await requireWalletPublics(network);
    const cached = await readWalletCache(network.id, address);
    if (!cached) return;
    await writeWalletCache(
      network.id,
      address,
      applyOwnBroadcast(cached, summary),
    );
  } catch {
    // The background refresh after the broadcast rebuilds the cache.
  }
}

/**
 * Verify the draft's selected inputs against the network: any input
 * already spent means the cache was stale. An unverifiable input
 * (network trouble) passes — the broadcast is the ultimate arbiter
 * and fails clearly if the input is gone.
 */
async function verifyDraftInputs(
  client: ElectrsClient,
  summary: SendSummary,
): Promise<"ok" | "spent"> {
  const results = await Promise.all(
    summary.inputs.map(async (input) => {
      try {
        return await client.isUtxoSpent(input.txid, input.vout);
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean) ? "spent" : "ok";
}

/**
 * Build a send draft from the cached wallet state, verified against
 * the network. On a stale input (spent since the last sync), one fresh
 * sync + rebuild is attempted; if the fresh draft is stale too, the
 * send is refused with a clear error instead of broadcasting a doomed
 * transaction. Throws TxError from the build (callers map it) and
 * ProviderRpcError for the stale-after-refresh refusal.
 */
async function buildVerifiedDraft(
  client: ElectrsClient,
  args: {
    to: string;
    amount: number;
    feeRate: number;
    rbf?: boolean;
  },
): Promise<{ draft: SendDraft; state: WalletState }> {
  const network = client.getNetwork();
  const build = (state: WalletState): SendDraft =>
    buildSendTransaction({
      utxos: state.utxos,
      to: args.to,
      amount: args.amount,
      feeRate: args.feeRate,
      network,
      changeAddress: state.changeAddress.address,
      rbf: args.rbf,
    });
  let state = await getWalletState(client);
  let draft = build(state);
  if ((await verifyDraftInputs(client, draft.summary)) === "spent") {
    const fresh = await syncWalletCache(client);
    state = fresh.state;
    draft = build(state);
    if ((await verifyDraftInputs(client, draft.summary)) === "spent") {
      throw new ProviderRpcError(
        ERROR_SERVER,
        "The selected coins were just spent. The wallet was refreshed — please try again.",
      );
    }
  }
  return { draft, state };
}

// Market price cache (Milestone 8): the price is global, not
// per-wallet, so the record carries no network or address key. Five
// minutes, matching the ELNUX market cache: opening the popup
// repeatedly must not hammer the public sources. On a fetch failure
// the stale cache is served rather than nothing.

const MARKET_CACHE_KEY = "marketInfoCache";
const MARKET_CACHE_TTL_MS = 5 * 60_000;

interface MarketCacheRecord {
  at: number;
  info: MarketInfo;
}

async function getMarketInfoCached(): Promise<MarketInfo | null> {
  const stored = await chrome.storage.session.get(MARKET_CACHE_KEY);
  const cached = stored[MARKET_CACHE_KEY] as MarketCacheRecord | undefined;
  if (cached && Date.now() - cached.at < MARKET_CACHE_TTL_MS) {
    return cached.info;
  }
  const fresh = await fetchMarketInfo();
  if (fresh) {
    const record: MarketCacheRecord = { at: Date.now(), info: fresh };
    await chrome.storage.session.set({ [MARKET_CACHE_KEY]: record });
    return fresh;
  }
  return cached?.info ?? null;
}

/** The accounts a page at this origin may currently see. */
async function currentAccountsFor(origin: string): Promise<string[]> {
  if (!(await isOriginConnected(origin))) return [];
  if (!(await isUnlocked())) return [];
  const address = await walletPrimaryAddress();
  return address ? [address] : [];
}

// ---------------------------------------------------------------------------
// Provider events
//
// The background remembers which tabs each origin has called from. The
// registry lives in chrome.storage.session, NOT in worker memory: an
// MV3 service worker is terminated after a short idle period, and an
// in-memory registry would silently forget every tab (field finding:
// lock/unlock events never reached a demo page whose last request had
// woken a previous worker instance). Session storage survives worker
// restarts and is cleared when the browser closes — which is also when
// the tabs themselves are gone. Events carry their target origin, and
// content scripts relay only events addressed to their own origin, so
// a recycled tab id can never deliver one site's accounts to another.

const KNOWN_TABS_KEY = "knownTabsByOrigin";

type KnownTabs = Record<string, number[]>;

async function loadKnownTabs(): Promise<KnownTabs> {
  const stored = await chrome.storage.session.get(KNOWN_TABS_KEY);
  const value = stored[KNOWN_TABS_KEY];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as KnownTabs;
  }
  return {};
}

async function rememberTab(
  origin: string,
  tabId: number | undefined,
): Promise<void> {
  if (tabId === undefined) return;
  const known = await loadKnownTabs();
  const tabs = known[origin] ?? [];
  if (tabs.includes(tabId)) return;
  known[origin] = [...tabs, tabId];
  await chrome.storage.session.set({ [KNOWN_TABS_KEY]: known });
}

function sendEventToTab(
  tabId: number,
  origin: string,
  event: string,
  args: unknown[],
): void {
  try {
    const sent = chrome.tabs.sendMessage(tabId, {
      kind: "nux-provider-event",
      origin,
      event,
      args,
    }) as unknown as Promise<unknown> | undefined;
    sent?.catch(() => {
      // The tab is gone or has no content script; events are best-effort.
    });
  } catch {
    // Same as above: never let event fan-out break request handling.
  }
}

async function emitAccountsChanged(origin: string): Promise<void> {
  const accounts = await currentAccountsFor(origin);
  const known = await loadKnownTabs();
  for (const tabId of known[origin] ?? []) {
    sendEventToTab(tabId, origin, "accountsChanged", [accounts]);
  }
}

async function emitAccountsChangedEverywhere(): Promise<void> {
  const known = await loadKnownTabs();
  for (const origin of Object.keys(known)) {
    await emitAccountsChanged(origin);
  }
}

async function emitNetworkChanged(origin: string): Promise<void> {
  const network = await activeNetwork();
  const known = await loadKnownTabs();
  for (const tabId of known[origin] ?? []) {
    sendEventToTab(tabId, origin, "networkChanged", [network.id]);
  }
}

async function emitNetworkChangedEverywhere(): Promise<void> {
  const known = await loadKnownTabs();
  for (const origin of Object.keys(known)) {
    await emitNetworkChanged(origin);
  }
}

// ---------------------------------------------------------------------------
// Approvals
//
// A pending approval lives only in this worker's memory: it is the
// promise behind one provider call, the approval window that will
// settle it, and the exact payload the user is shown (a built send
// draft, a message, a summarized PSBT). What is approved is what
// executes — payloads are built and validated BEFORE the window opens,
// and execution at approval time re-derives nothing the user did not
// see. If the worker restarts while a window is open, the promise is
// gone with it; the window then reports that the request is no longer
// pending and the page can simply ask again.

type ApprovalKind = "connect" | "send" | "signMessage" | "signPsbt" | "sendPsbt";

type Ownership = Map<string, { chain: 0 | 1; index: number }>;

interface PendingRequest {
  id: string;
  origin: string;
  kind: ApprovalKind;
  /** The network the request was built on. Execution always uses
   * this network, never the active one: the user may switch
   * networks while an approval is pending, and what was shown is
   * what executes. */
  network: NuxNetwork;
  windowId: number | null;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: ProviderRpcError) => void;
  sendDraft?: SendDraft;
  sendOwnership?: Ownership;
  message?: string;
  psbtBase64?: string;
  psbtSummary?: PsbtSummary;
  psbtOwnership?: Ownership;
}

const pendingById = new Map<string, PendingRequest>();
const pendingByOrigin = new Map<string, PendingRequest>();

function settleRequest(
  pending: PendingRequest,
  outcome: { value: unknown } | { error: ProviderRpcError },
  closeWindow: boolean,
): void {
  if (pending.settled) return;
  pending.settled = true;
  pendingById.delete(pending.id);
  if (pendingByOrigin.get(pending.origin) === pending) {
    pendingByOrigin.delete(pending.origin);
  }
  if ("value" in outcome) {
    pending.resolve(outcome.value);
  } else {
    pending.reject(outcome.error);
  }
  if (closeWindow && pending.windowId !== null) {
    void chrome.windows.remove(pending.windowId).catch(() => {
      // The window may already be gone.
    });
  }
}

function rejectRequest(pending: PendingRequest, closeWindow: boolean): void {
  settleRequest(
    pending,
    {
      error: new ProviderRpcError(
        ERROR_USER_REJECTED,
        "The user rejected the request.",
      ),
    },
    closeWindow,
  );
}

interface ApprovalExtras {
  sendDraft?: SendDraft;
  sendOwnership?: Ownership;
  message?: string;
  psbtBase64?: string;
  psbtSummary?: PsbtSummary;
  psbtOwnership?: Ownership;
}

/**
 * Sentinel origin for approvals the wallet itself starts (a send from
 * the popup). No website can have this origin, so it can never collide
 * with a dApp request; the approval window renders it as "This wallet".
 * It also gives popup sends the same one-at-a-time guard the provider
 * path gets from pendingByOrigin.
 */
const WALLET_ORIGIN = "wallet";

/**
 * Register a pending approval without opening a window. The approval
 * window path and the popup's inline review share this: both need the
 * one-at-a-time guard from pendingByOrigin and the settle-by-id path,
 * but only the window path creates a window.
 */
function createPending(
  origin: string,
  kind: ApprovalKind,
  network: NuxNetwork,
  extras: ApprovalExtras,
): { pending: PendingRequest; promise: Promise<unknown> } {
  const pending: PendingRequest = {
    id: crypto.randomUUID(),
    origin,
    kind,
    network,
    windowId: null,
    settled: false,
    resolve: () => {},
    reject: () => {},
    ...extras,
  };
  const promise = new Promise<unknown>((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  pendingById.set(pending.id, pending);
  pendingByOrigin.set(origin, pending);
  return { pending, promise };
}

async function openApprovalWindow(
  origin: string,
  kind: ApprovalKind,
  tabId: number | undefined,
  network: NuxNetwork,
  extras: ApprovalExtras,
): Promise<unknown> {
  const { pending, promise } = createPending(origin, kind, network, extras);
  await rememberTab(origin, tabId);

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approval.html?id=${pending.id}`),
      type: "popup",
      width: 400,
      height: 600,
      focused: true,
    });
    pending.windowId = win?.id ?? null;
    if (pending.settled && pending.windowId !== null) {
      // Settled while the window was being created; do not leave a
      // stray window behind.
      void chrome.windows.remove(pending.windowId).catch(() => {});
    }
  } catch {
    rejectRequest(pending, false);
  }
  return promise;
}

function busyError(): ProviderRpcError {
  return new ProviderRpcError(
    ERROR_SERVER,
    "Another request from this site is awaiting approval.",
  );
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const pending of pendingById.values()) {
    if (pending.windowId === windowId) {
      // Closing the approval window without a decision is a rejection.
      rejectRequest(pending, false);
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Request preparation. Each builder validates fully and produces the
// exact payload the approval window will show; nothing here moves
// value or signs.

async function requireConnectedAndWallet(origin: string): Promise<void> {
  if (!(await isOriginConnected(origin))) {
    throw new ProviderRpcError(
      ERROR_UNAUTHORIZED,
      "This site is not connected.",
    );
  }
  if (!(await hasVault())) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
}

function txErrorToRpc(error: TxError): ProviderRpcError {
  return new ProviderRpcError(
    error.kind === "invalid" ? ERROR_INVALID_PARAMS : ERROR_SERVER,
    error.message,
  );
}

/** A free-text string parameter: bare string, [string], or {key: string}. */
function extractStringParam(
  params: unknown,
  key: string,
): string | null {
  if (typeof params === "string") return params;
  if (Array.isArray(params)) {
    return typeof params[0] === "string" ? params[0] : null;
  }
  if (params && typeof params === "object") {
    const value = (params as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function parseAmountParam(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  throw new ProviderRpcError(
    ERROR_INVALID_PARAMS,
    "Amount must be an integer number of nusan.",
  );
}

function parseSendParams(params: unknown): {
  to: string;
  amount: number;
  feeRate?: number;
} {
  let record: Record<string, unknown> = {};
  if (Array.isArray(params)) {
    record = { to: params[0], amount: params[1], feeRate: params[2] };
  } else if (params && typeof params === "object") {
    record = params as Record<string, unknown>;
  }
  if (typeof record.to !== "string" || record.to.length === 0) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "A recipient address (to) is required.",
    );
  }
  const amount = parseAmountParam(record.amount);
  let feeRate: number | undefined;
  if (record.feeRate !== undefined && record.feeRate !== null) {
    // Locked rule: a dApp-supplied fee rate is accepted only inside
    // 1..MAX_FEE_RATE nusan/vbyte; anything else is -32602.
    if (
      typeof record.feeRate !== "number" ||
      !Number.isInteger(record.feeRate) ||
      record.feeRate < 1 ||
      record.feeRate > MAX_FEE_RATE
    ) {
      throw new ProviderRpcError(
        ERROR_INVALID_PARAMS,
        `feeRate must be an integer between 1 and ${MAX_FEE_RATE} nusan/vbyte.`,
      );
    }
    feeRate = record.feeRate;
  }
  return { to: record.to, amount, feeRate };
}

async function handleRequestAccounts(
  origin: string,
  tabId: number | undefined,
): Promise<unknown> {
  if (!(await hasVault())) {
    throw new ProviderRpcError(
      ERROR_UNAUTHORIZED,
      "No wallet exists yet. Create one from the extension popup first.",
    );
  }

  // One approval per origin at a time. A repeated connection request
  // joins the pending one instead of stacking windows; any other kind
  // of pending request makes this one wait its turn.
  const existing = pendingByOrigin.get(origin);
  if (existing) {
    if (existing.kind !== "connect") throw busyError();
    if (existing.windowId !== null) {
      void chrome.windows
        .update(existing.windowId, { focused: true })
        .catch(() => {});
    }
    return new Promise<unknown>((resolve, reject) => {
      const priorResolve = existing.resolve;
      const priorReject = existing.reject;
      existing.resolve = (value) => {
        priorResolve(value);
        resolve(value);
      };
      existing.reject = (error) => {
        priorReject(error);
        reject(error);
      };
    });
  }

  // Fast path: already connected and unlocked needs no window.
  const accounts = await currentAccountsFor(origin);
  if (accounts.length > 0) {
    await touchSession();
    return accounts;
  }

  return openApprovalWindow(
    origin,
    "connect",
    tabId,
    await activeNetwork(),
    {},
  );
}

async function handleSendTransaction(
  origin: string,
  params: unknown,
  tabId: number | undefined,
): Promise<unknown> {
  await requireConnectedAndWallet(origin);
  if (pendingByOrigin.has(origin)) throw busyError();
  const { to, amount, feeRate: givenRate } = parseSendParams(params);

  const network = await activeNetwork();
  const client = new ElectrsClient(network);
  const networkRate = await client.getFeeRate();
  const feeRate =
    givenRate ??
    Math.min(MAX_FEE_RATE, Math.max(1, Math.round(networkRate)));
  let draft: SendDraft;
  let state: WalletState;
  try {
    ({ draft, state } = await buildVerifiedDraft(client, {
      to,
      amount,
      feeRate,
    }));
  } catch (error) {
    if (error instanceof TxError) throw txErrorToRpc(error);
    if (error instanceof ProviderRpcError) throw error;
    throw new ProviderRpcError(
      ERROR_SERVER,
      `Could not read the wallet's UTXOs: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  return openApprovalWindow(origin, "send", tabId, network, {
    sendDraft: draft,
    sendOwnership: ownershipMap(state),
  });
}

async function handleSignMessage(
  origin: string,
  params: unknown,
  tabId: number | undefined,
): Promise<unknown> {
  await requireConnectedAndWallet(origin);
  if (pendingByOrigin.has(origin)) throw busyError();
  const message = extractStringParam(params, "message");
  if (message === null || message.length === 0) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "A non-empty message string is required.",
    );
  }
  if (message.length > 8192) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "The message is too long to sign.",
    );
  }
  return openApprovalWindow(
    origin,
    "signMessage",
    tabId,
    await activeNetwork(),
    { message },
  );
}

async function handlePsbtRequest(
  origin: string,
  params: unknown,
  tabId: number | undefined,
  broadcast: boolean,
): Promise<unknown> {
  await requireConnectedAndWallet(origin);
  if (pendingByOrigin.has(origin)) throw busyError();
  const psbtBase64 = extractStringParam(params, "psbt");
  if (psbtBase64 === null || psbtBase64.length === 0) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "A base64 PSBT is required.",
    );
  }
  const network = await activeNetwork();
  const client = new ElectrsClient(network);
  let state;
  try {
    state = await getWalletState(client);
  } catch (error) {
    if (error instanceof ProviderRpcError) throw error;
    throw new ProviderRpcError(
      ERROR_SERVER,
      `Could not read the wallet state: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  let summary: PsbtSummary;
  try {
    summary = summarizePsbt(psbtBase64, network).summary;
  } catch (error) {
    if (error instanceof TxError) throw txErrorToRpc(error);
    throw error;
  }
  const owned = ownershipMap(state);
  for (const input of summary.inputs) {
    if (!input.address || !owned.has(input.address)) {
      // Ownership is verified BEFORE approval: the wallet signs only
      // for its own addresses, without exception.
      throw new ProviderRpcError(
        ERROR_INVALID_PARAMS,
        "The PSBT spends an input that does not belong to this wallet.",
      );
    }
  }
  if (summary.feeRate > MAX_FEE_RATE) {
    // Locked rule: the recalculated implied fee rate is capped.
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      `The PSBT's implied fee rate of ${summary.feeRate} nusan/vbyte exceeds the maximum of ${MAX_FEE_RATE}.`,
    );
  }
  return openApprovalWindow(
    origin,
    broadcast ? "sendPsbt" : "signPsbt",
    tabId,
    network,
    {
      psbtBase64,
      psbtSummary: summary,
      psbtOwnership: owned,
    },
  );
}

// ---------------------------------------------------------------------------
// Provider requests

async function handleProviderRequest(
  origin: string,
  request: ProviderRequest,
  tabId: number | undefined,
): Promise<unknown> {
  if (!request || typeof request.method !== "string") {
    throw new ProviderRpcError(ERROR_UNSUPPORTED_METHOD, "Malformed request.");
  }
  void rememberTab(origin, tabId).catch(() => {
    // Registry writes are best-effort; reads stay storage-gated.
  });

  switch (request.method) {
    case "nux_getNetwork":
      return (await activeNetwork()).id;

    case "nux_requestAccounts":
      return handleRequestAccounts(origin, tabId);

    case "nux_getAccounts": {
      // Origin gating (locked decision): only connected origins receive
      // an answer, and accounts are exposed only while unlocked. Every
      // other state answers with an empty list.
      const accounts = await currentAccountsFor(origin);
      if (accounts.length > 0) {
        await touchSession();
      }
      return accounts;
    }

    case "nux_getBalance": {
      if (!(await isOriginConnected(origin))) {
        throw new ProviderRpcError(
          ERROR_UNAUTHORIZED,
          "This site is not connected.",
        );
      }
      if (!(await isUnlocked())) {
        throw new ProviderRpcError(ERROR_UNAUTHORIZED, "The wallet is locked.");
      }
      const address = await walletPrimaryAddress();
      if (!address) {
        throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
      }
      const client = new ElectrsClient(await activeNetwork());
      const { confirmed, unconfirmed } = await getCachedBalances(client);
      await touchSession();
      // Integer nusan, per the specification.
      return { confirmed, unconfirmed };
    }

    case "nux_sendTransaction":
      return handleSendTransaction(origin, request.params, tabId);

    case "nux_signMessage":
      return handleSignMessage(origin, request.params, tabId);

    case "nux_signPsbt":
      return handlePsbtRequest(origin, request.params, tabId, false);

    case "nux_sendPsbt":
      return handlePsbtRequest(origin, request.params, tabId, true);

    default:
      if (isKnownMethod(request.method)) {
        throw new ProviderRpcError(
          ERROR_UNSUPPORTED_METHOD,
          `Method not implemented yet in this milestone: ${request.method}`,
        );
      }
      throw new ProviderRpcError(
        ERROR_UNSUPPORTED_METHOD,
        `Unsupported method: ${request.method}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Approval execution. Runs only after an explicit approval, with the
// exact payload the user was shown.

async function executeApproval(pending: PendingRequest): Promise<unknown> {
  // The pending's own network, never the active one: the user may
  // have switched networks while the approval was pending, and what
  // was shown is what executes.
  const network = pending.network;
  switch (pending.kind) {
    case "connect": {
      const address = await walletPrimaryAddressOn(network);
      if (!address) throw new Error("No wallet exists yet.");
      await connectOrigin(pending.origin, [address]);
      await touchSession();
      return [address];
    }
    case "send": {
      if (!pending.sendDraft || !pending.sendOwnership) {
        throw new Error("The send request is incomplete.");
      }
      const mnemonic = await mnemonicFromSession();
      const { psbt } = summarizePsbt(pending.sendDraft.psbtBase64, network);
      signWalletPsbt(psbt, mnemonic, network, pending.sendOwnership);
      const hex = finalizeToHex(psbt);
      const txid = await new ElectrsClient(network).broadcastTx(hex);
      await applyBroadcastToCache(pending.sendDraft.summary, network);
      void refreshWalletCacheInBackground();
      return txid;
    }
    case "signMessage": {
      if (pending.message === undefined) {
        throw new Error("The sign request is incomplete.");
      }
      const mnemonic = await mnemonicFromSession();
      const key = derivePrivateKey(mnemonic, network, 0, 0);
      return signMessageLegacy(pending.message, key, network);
    }
    case "signPsbt":
    case "sendPsbt": {
      if (!pending.psbtBase64 || !pending.psbtOwnership) {
        throw new Error("The PSBT request is incomplete.");
      }
      const mnemonic = await mnemonicFromSession();
      const { psbt } = summarizePsbt(pending.psbtBase64, network);
      signWalletPsbt(psbt, mnemonic, network, pending.psbtOwnership);
      if (pending.kind === "signPsbt") {
        return psbt.toBase64();
      }
      const hex = finalizeToHex(psbt);
      const txid = await new ElectrsClient(network).broadcastTx(hex);
      // No optimistic update here: the PSBT summary carries no
      // outpoints, so the spent inputs are unknown. The background
      // refresh rebuilds the cache, and the pre-sign verification
      // guards the next send against the stale record meanwhile.
      void refreshWalletCacheInBackground();
      return txid;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal (extension page) requests

interface InternalStatus {
  network: NuxNetwork["id"];
  networkLabel: string;
  electrsBaseUrl: string;
  tipHeight: number | null;
  feeRate: number | null;
  statusError?: string;
  hasVault: boolean;
  unlocked: boolean;
  address: string | null;
  confirmedBalance: number | null;
  unconfirmedBalance: number | null;
}

async function handleGetStatus(): Promise<InternalStatus> {
  const network = await activeNetwork();
  const client = new ElectrsClient(network);
  const status: InternalStatus = {
    network: network.id,
    networkLabel: network.label,
    electrsBaseUrl: network.electrsBaseUrl,
    tipHeight: null,
    feeRate: null,
    hasVault: await hasVault(),
    unlocked: await isUnlocked(),
    address: await walletPrimaryAddress(),
    confirmedBalance: null,
    unconfirmedBalance: null,
  };
  try {
    // Balances first: they come from the persistent cache, so a tip or
    // fee failure must not blank figures the cache already holds.
    if (status.address) {
      const balances = await getCachedBalances(client);
      status.confirmedBalance = balances.confirmed;
      status.unconfirmedBalance = balances.unconfirmed;
    }
    status.tipHeight = await client.getTipHeight();
    status.feeRate = await client.getFeeRate();
  } catch (error) {
    status.statusError =
      error instanceof Error ? error.message : "electrs unreachable";
  }
  return status;
}

interface ApprovalRequestView {
  id: string;
  origin: string;
  kind: ApprovalKind;
  network: NuxNetwork["id"];
  networkLabel: string;
  hasVault: boolean;
  unlocked: boolean;
  alreadyConnected: boolean;
  /** The primary address; shown only while unlocked. */
  address: string | null;
  /** Kind-specific summaries; present only while unlocked. */
  sendSummary?: SendDraft["summary"];
  message?: string;
  psbtSummary?: PsbtSummary;
}

async function handleGetApprovalRequest(id: string): Promise<ApprovalRequestView> {
  const pending = pendingById.get(id);
  if (!pending) {
    throw new ProviderRpcError(
      ERROR_SERVER,
      "This approval request is no longer pending.",
    );
  }
  const unlocked = await isUnlocked();
  return {
    id: pending.id,
    origin: pending.origin,
    kind: pending.kind,
    // The pending's own network, not the active one: the approval
    // window shows what was asked, even if the user switched since.
    network: pending.network.id,
    networkLabel: pending.network.label,
    hasVault: await hasVault(),
    unlocked,
    alreadyConnected: await isOriginConnected(pending.origin),
    address: unlocked ? await walletPrimaryAddressOn(pending.network) : null,
    sendSummary: unlocked ? pending.sendDraft?.summary : undefined,
    message: unlocked ? pending.message : undefined,
    psbtSummary: unlocked ? pending.psbtSummary : undefined,
  };
}

async function handleResolveApproval(
  id: string,
  approved: boolean,
): Promise<{ resolved: true; execError?: string }> {
  const pending = pendingById.get(id);
  if (!pending) {
    throw new ProviderRpcError(
      ERROR_SERVER,
      "This approval request is no longer pending.",
    );
  }
  if (!approved) {
    rejectRequest(pending, true);
    return { resolved: true };
  }
  if (!(await isUnlocked())) {
    // The vault may have auto-locked while the window was open; the
    // approval page falls back to its unlock form on this error.
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "The wallet is locked.");
  }
  try {
    const value = await executeApproval(pending);
    settleRequest(pending, { value }, true);
    if (pending.kind === "connect") {
      await emitAccountsChanged(pending.origin);
    }
    return { resolved: true };
  } catch (error) {
    // Execution failed (e.g. the network rejected the broadcast): the
    // waiting page call settles with the failure, and the approval
    // window shows it before closing.
    const message =
      error instanceof Error ? error.message : "Execution failed.";
    settleRequest(
      pending,
      { error: new ProviderRpcError(ERROR_SERVER, message) },
      true,
    );
    return { resolved: true, execError: message };
  }
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith("chrome-extension://")
  );
}

interface InternalMessage {
  password?: string;
  mnemonic?: string;
  id?: string;
  approved?: boolean;
  origin?: string;
  enabled?: boolean;
  to?: string;
  amount?: number;
  rbf?: boolean;
  label?: string;
  address?: string;
  unit?: string;
  network?: string;
  acknowledge?: boolean;
}

type InternalHandler = (message: InternalMessage) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Popup-initiated sends (Milestone 6, inline review in Milestone 11).
// The popup builds no transaction itself: it sends {to, amount, rbf}
// here, the background builds the draft with the same engine the
// provider path uses, and the popup reviews the draft inline instead
// of opening the approval window — the user is already looking at the
// popup, so the decision stays there. Two differences from the
// provider path: there is no dApp origin (WALLET_ORIGIN stands in),
// and the popup may close mid-review, so the pending review is
// resumable (getPendingWalletSend) and the settlement is recorded in
// storage for the popup to show on its next open.

const LAST_SEND_KEY = "lastPopupSend";

interface LastPopupSend {
  to: string;
  amount: number;
  fee: number;
  rbf: boolean;
  ok: boolean;
  txid: string | null;
  error: string | null;
  at: number;
  /** The network the send executed on. Records written before this
   * field existed read as testnet. */
  network?: NuxNetwork["id"];
}

async function recordLastPopupSend(result: LastPopupSend): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_SEND_KEY]: result });
  } catch {
    // The send already settled; a lost record must not fail anything.
  }
}

async function handlePopupSendDraft(
  message: InternalMessage,
): Promise<{ summary: SendDraft["summary"]; id: string }> {
  // Errors here are ProviderRpcError on purpose: the onMessage wrapper
  // passes only ProviderRpcError and VaultError messages through to
  // the popup — a plain Error would surface as "Internal error." and
  // the form could never tell the user what was wrong.
  const to = typeof message.to === "string" ? message.to.trim() : "";
  const amount = message.amount;
  const rbf = message.rbf === true;
  if (!to) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "A recipient address is required.",
    );
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "Amount must be a positive integer number of nusan.",
    );
  }
  if (!(await hasVault())) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  if (!(await isUnlocked())) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "The wallet is locked.");
  }
  if (pendingByOrigin.has(WALLET_ORIGIN)) {
    throw new ProviderRpcError(
      ERROR_SERVER,
      "Another send from this wallet is awaiting approval.",
    );
  }
  const network = await activeNetwork();
  if (amount < network.dustLimit) {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      `Amount is below the dust limit (${network.dustLimit} nusan).`,
    );
  }
  const client = new ElectrsClient(network);
  // No dApp supplies a fee rate here: the active network's own rate,
  // clamped to the locked 1..MAX_FEE_RATE band.
  const networkRate = await client.getFeeRate();
  const feeRate = Math.min(MAX_FEE_RATE, Math.max(1, Math.round(networkRate)));
  let draft: SendDraft;
  let state: WalletState;
  try {
    ({ draft, state } = await buildVerifiedDraft(client, {
      to,
      amount,
      feeRate,
      rbf,
    }));
  } catch (error) {
    if (error instanceof TxError) {
      throw new ProviderRpcError(
        error.kind === "invalid" ? ERROR_INVALID_PARAMS : ERROR_SERVER,
        error.message,
      );
    }
    if (error instanceof ProviderRpcError) throw error;
    throw new ProviderRpcError(
      ERROR_SERVER,
      `Could not read the wallet's UTXOs: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  // No approval window: the popup reviews the draft inline. Register
  // the pending (the one-at-a-time guard + the settle-by-id path) and
  // return its id with the summary; the popup decides via
  // popupSendConfirm / popupSendCancel. The settlement is still
  // recorded for the last-send line — except a user rejection, which
  // is a deliberate "no", not a failed send.
  const { pending, promise: settled } = createPending(
    WALLET_ORIGIN,
    "send",
    network,
    {
      sendDraft: draft,
      sendOwnership: ownershipMap(state),
    },
  );
  void settled.then(
    (txid) =>
      recordLastPopupSend({
        to,
        amount,
        fee: draft.summary.fee,
        rbf,
        ok: true,
        txid: typeof txid === "string" ? txid : null,
        error: null,
        at: Date.now(),
        network: network.id,
      }),
    (error) => {
      if (
        error instanceof ProviderRpcError &&
        error.code === ERROR_USER_REJECTED
      ) {
        return;
      }
      return recordLastPopupSend({
        to,
        amount,
        fee: draft.summary.fee,
        rbf,
        ok: false,
        txid: null,
        error: error instanceof Error ? error.message : "Send failed.",
        at: Date.now(),
        network: network.id,
      });
    },
  );
  return { summary: draft.summary, id: pending.id };
}

/**
 * The wallet's own pending send, for the popup's inline review. The
 * popup must never decide a dApp request, so these handlers verify
 * the pending belongs to the wallet before touching it.
 */
function walletSendPending(id: string | undefined): PendingRequest {
  const pending = id === undefined ? undefined : pendingById.get(id);
  if (
    !pending ||
    pending.origin !== WALLET_ORIGIN ||
    pending.kind !== "send"
  ) {
    throw new ProviderRpcError(
      ERROR_SERVER,
      "This send is no longer awaiting review.",
    );
  }
  return pending;
}

async function handlePopupSendConfirm(
  message: InternalMessage,
): Promise<{ resolved: true; execError?: string }> {
  const pending = walletSendPending(message.id);
  return handleResolveApproval(pending.id, true);
}

async function handlePopupSendCancel(
  message: InternalMessage,
): Promise<{ resolved: true }> {
  const pending = walletSendPending(message.id);
  rejectRequest(pending, false);
  return { resolved: true };
}

async function handleGetPendingWalletSend(): Promise<{
  pending: { id: string; summary: SendDraft["summary"] } | null;
}> {
  const pending = pendingByOrigin.get(WALLET_ORIGIN);
  if (
    !pending ||
    pending.settled ||
    pending.kind !== "send" ||
    !pending.sendDraft
  ) {
    return { pending: null };
  }
  // The summary names the recipient and the amounts: only while
  // unlocked, the same rule the approval window's read follows.
  if (!(await isUnlocked())) {
    return { pending: null };
  }
  return { pending: { id: pending.id, summary: pending.sendDraft.summary } };
}

/**
 * The MAX button's figure: the largest amount one transaction can
 * send, from the cached UTXO set at the active network's own fee
 * rate. Read-only (no draft is built), but the send form is an
 * unlocked-only surface, so the lock rule matches the draft path.
 */
async function handleGetMaxSendable(): Promise<{
  amount: number;
  fee: number;
  feeRate: number;
}> {
  if (!(await hasVault())) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  if (!(await isUnlocked())) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "The wallet is locked.");
  }
  const network = await activeNetwork();
  const client = new ElectrsClient(network);
  const networkRate = await client.getFeeRate();
  const feeRate = Math.min(MAX_FEE_RATE, Math.max(1, Math.round(networkRate)));
  const state = await getWalletState(client);
  try {
    const { amount, fee } = maxSendable({
      utxos: state.utxos,
      feeRate,
      dustLimit: network.dustLimit,
    });
    return { amount, fee, feeRate };
  } catch (error) {
    if (error instanceof TxError) {
      throw new ProviderRpcError(ERROR_SERVER, error.message);
    }
    throw error;
  }
}

/**
 * Switch the active network (Milestone 12). The setting persists in
 * chrome.storage.local, so it survives browser restarts; testnet
 * stays the default for a fresh install. Switching is a public
 * setting — it needs no vault and no unlock — but the first switch
 * to mainnet needs a one-time acknowledgment that mainnet moves
 * real funds; the popup shows the confirmation card and passes
 * acknowledge: true. A wallet send under inline review belongs to
 * the old network and does not survive the switch; dApp pendings
 * keep their own network and execute on it. Connected tabs learn
 * about the switch through networkChanged + accountsChanged.
 */
const MAINNET_ACK_KEY = "mainnetAcknowledged";

async function readMainnetAcknowledged(): Promise<boolean> {
  const stored = await chrome.storage.local.get([MAINNET_ACK_KEY]);
  return stored[MAINNET_ACK_KEY] === true;
}

async function handleSetNetwork(
  message: InternalMessage,
): Promise<{ network: NuxNetwork["id"] }> {
  const id = message.network;
  if (id !== "mainnet" && id !== "testnet") {
    throw new ProviderRpcError(
      ERROR_INVALID_PARAMS,
      "Unknown network. Expected \"mainnet\" or \"testnet\".",
    );
  }
  const current = await readActiveNetworkId();
  if (id === current) return { network: current };
  if (id === "mainnet") {
    if (
      !(await readMainnetAcknowledged()) &&
      message.acknowledge !== true
    ) {
      throw new ProviderRpcError(
        ERROR_INVALID_PARAMS,
        "Switching to mainnet needs a one-time acknowledgment.",
      );
    }
    if (message.acknowledge === true) {
      await chrome.storage.local.set({ [MAINNET_ACK_KEY]: true });
    }
  }
  await writeActiveNetworkId(id);
  const walletPending = pendingByOrigin.get(WALLET_ORIGIN);
  if (walletPending) rejectRequest(walletPending, false);
  // Fresh state for the new network; the sync also re-targets the
  // incoming-coin watcher at the new network's addresses.
  void refreshWalletCacheInBackground();
  await emitNetworkChangedEverywhere();
  await emitAccountsChangedEverywhere();
  return { network: id };
}

const internalHandlers: Record<string, InternalHandler> = {
  getStatus: async () => handleGetStatus(),
  vaultCreate: async (message) => {
    const { mnemonic } = await createVault(message.password ?? "");
    return { mnemonic, address: await walletPrimaryAddress() };
  },
  vaultImport: async (message) => {
    await importVault(message.mnemonic ?? "", message.password ?? "");
    return { address: await walletPrimaryAddress() };
  },
  vaultUnlock: async (message) => {
    await unlockVault(message.password ?? "");
    await emitAccountsChangedEverywhere();
    return { unlocked: true };
  },
  vaultLock: async () => {
    await lockVault();
    await emitAccountsChangedEverywhere();
    return { unlocked: false };
  },
  getApprovalRequest: async (message) =>
    handleGetApprovalRequest(message.id ?? ""),
  resolveApproval: async (message) =>
    handleResolveApproval(message.id ?? "", message.approved === true),
  getConnections: async () => ({ connections: await listConnections() }),
  getActivity: async () => ({
    entries: await getActivityEntries((await activeNetwork()).id),
    enabled: await isNotificationsEnabled(),
  }),
  setNotificationsEnabled: async (message) => {
    const enabled = message.enabled === true;
    await setNotificationsEnabled(enabled);
    if (!enabled) await clearBadge();
    return { enabled };
  },
  getDisplayUnit: async () => ({ unit: await readDisplayUnit() }),
  setDisplayUnit: async (message) => {
    const unit = parseDisplayUnit(message.unit);
    await writeDisplayUnit(unit);
    return { unit };
  },
  notificationsOpened: async () => {
    await clearBadge();
    return { ok: true };
  },
  disconnectOrigin: async (message) => {
    const origin = message.origin ?? "";
    await removeConnection(origin);
    await emitAccountsChanged(origin);
    return { connections: await listConnections() };
  },
  popupSendDraft: async (message) => handlePopupSendDraft(message),
  popupSendConfirm: async (message) => handlePopupSendConfirm(message),
  popupSendCancel: async (message) => handlePopupSendCancel(message),
  getPendingWalletSend: async () => handleGetPendingWalletSend(),
  getMaxSendable: async () => handleGetMaxSendable(),
  getNetwork: async () => ({
    network: await readActiveNetworkId(),
    mainnetAcknowledged: await readMainnetAcknowledged(),
  }),
  setNetwork: async (message) => handleSetNetwork(message),
  getLastSend: async () => {
    const stored = await chrome.storage.local.get(LAST_SEND_KEY);
    const lastSend = stored[LAST_SEND_KEY] as LastPopupSend | undefined;
    if (!lastSend) return { lastSend: null };
    // The last-send line belongs to its network; a testnet send
    // must not show while the wallet is on mainnet (and back).
    // Records written before the network field existed read as
    // testnet.
    const network = await activeNetwork();
    if ((lastSend.network ?? "testnet") !== network.id) {
      return { lastSend: null };
    }
    return { lastSend };
  },
  addressBookList: async () => {
    const entries = await listAddressBookEntries();
    const network = await activeNetwork();
    return { entries: entries.filter((entry) => entry.network === network.id) };
  },
  addressBookAdd: async (message) => {
    try {
      const entry = await addAddressBookEntry(
        message.label ?? "",
        message.address ?? "",
        await activeNetwork(),
      );
      return { entry };
    } catch (error) {
      // Same rule as the popup send path: only ProviderRpcError
      // messages reach the popup, so translate here.
      if (error instanceof AddressBookError) {
        throw new ProviderRpcError(ERROR_INVALID_PARAMS, error.message);
      }
      throw error;
    }
  },
  addressBookRemove: async (message) => {
    const removed = await removeAddressBookEntry(message.id ?? "");
    return { removed };
  },
  getMarketInfo: async () => ({ market: await getMarketInfoCached() }),
  getReceiveAddress: async () => {
    const network = await activeNetwork();
    const { address } = await requireWalletPublics(network);
    const state = await getWalletState(new ElectrsClient(network));
    const index = await readReceiveAddressIndex(network.id, address);
    const current = currentReceiveAddress(state, index);
    return {
      address: current.address,
      index: current.index,
      canRefresh: nextUnusedReceiveIndex(state, current.index) !== null,
    };
  },
  refreshReceiveAddress: async () => {
    const network = await activeNetwork();
    const { address } = await requireWalletPublics(network);
    const state = await getWalletState(new ElectrsClient(network));
    const index = await readReceiveAddressIndex(network.id, address);
    const current = currentReceiveAddress(state, index);
    const next = nextUnusedReceiveIndex(state, current.index);
    if (next === null) {
      throw new ProviderRpcError(
        ERROR_INVALID_PARAMS,
        "No further unused receive address is available.",
      );
    }
    await writeReceiveAddressIndex(network.id, address, next);
    const refreshed = currentReceiveAddress(state, next);
    // Watch the fresh address at once, so its first payment notifies.
    await updateWatchedAddresses(state, network, address);
    return {
      address: refreshed.address,
      index: refreshed.index,
      canRefresh: nextUnusedReceiveIndex(state, refreshed.index) !== null,
    };
  },
};

chrome.runtime.onInstalled.addListener(() => {
  // Session storage holds the vault decryption key while the vault is
  // unlocked. Restrict it to trusted contexts so no web page context
  // can ever read it.
  try {
    void chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Older Chrome versions: access level defaults apply.
  }
  // Periodic wake-up: drives the vault auto-lock check and the
  // incoming-coin notification polling.
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  void (async () => {
    if (await checkAutoLock()) {
      await emitAccountsChangedEverywhere();
    }
    // Incoming-coin watch (Milestone 5). A watcher failure must never
    // break the alarm or the auto-lock above; and the check needs no
    // unlocked vault — it only reads public addresses.
    try {
      const network = await activeNetwork();
      const client = new ElectrsClient(network);
      await runNotificationCheck({
        client,
        network,
        primaryAddress: await walletPrimaryAddress(),
        getWalletState: () => getWalletState(client),
      });
    } catch {
      // The next poll retries; the alarm itself keeps running.
    }
    // Wallet cache refresh (Milestone 9). Keeps the offline UTXO cache
    // fresh while the browser runs, so sends build from local data.
    // Never throws; the next tick retries.
    void refreshWalletCacheInBackground();
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async (): Promise<unknown> => {
    if (message?.kind === "nux-provider-request") {
      const origin =
        typeof message.origin === "string" && message.origin
          ? message.origin
          : sender.origin ?? "";
      if (!origin) {
        throw new ProviderRpcError(
          ERROR_UNAUTHORIZED,
          "Requests without an origin are not accepted.",
        );
      }
      return handleProviderRequest(
        origin,
        message.request as ProviderRequest,
        sender.tab?.id,
      );
    }
    if (message?.kind === "nux-internal" && typeof message.request === "string") {
      // Internal requests carry passwords and drive the vault; they are
      // accepted only from this extension's own pages (popup, approval).
      if (!isExtensionPage(sender)) {
        throw new ProviderRpcError(
          ERROR_UNAUTHORIZED,
          "Internal requests are only accepted from extension pages.",
        );
      }
      const handler = internalHandlers[message.request];
      if (!handler) {
        throw new ProviderRpcError(
          ERROR_UNSUPPORTED_METHOD,
          `Unknown internal request: ${message.request}`,
        );
      }
      return handler(message);
    }
    throw new ProviderRpcError(ERROR_UNSUPPORTED_METHOD, "Unknown message kind.");
  };

  run().then(
    (result) => sendResponse({ ok: true, result }),
    (error: unknown) => {
      if (error instanceof ProviderRpcError) {
        sendResponse({
          ok: false,
          error: { code: error.code, message: error.message },
        });
      } else if (error instanceof VaultError) {
        sendResponse({
          ok: false,
          error: { code: ERROR_SERVER, message: error.message },
        });
      } else {
        sendResponse({
          ok: false,
          error: { code: -32603, message: "Internal error." },
        });
      }
    },
  );
  return true; // Keep the message channel open for the async response.
});

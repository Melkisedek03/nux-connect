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
// - Fan provider events (accountsChanged) out to the tabs an origin is
//   known to run in. Events are a courtesy only: every read is still
//   gated against the stored state, so a missed event can never leak
//   an address.
// - Serve popup status: network, tip height, fee rate, and — when a
//   wallet exists — the primary address and its balances, all from the
//   active network's own electrs instance.

import "../lib/globals";
import {
  connectOrigin,
  disconnectOrigin as removeConnection,
  isOriginConnected,
  listConnections,
} from "../lib/connections";
import { ElectrsClient } from "../lib/electrs";
import { derivePrivateKey, primaryAddress } from "../lib/keys";
import { DEFAULT_NETWORK_ID, getNetwork, type NuxNetwork } from "../lib/networks";
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
  signMessageLegacy,
  signWalletPsbt,
  summarizePsbt,
  type PsbtSummary,
  type SendDraft,
} from "../lib/tx";
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
} from "../lib/vault";
import { discoverWallet, ownershipMap } from "../lib/wallet";

const POLL_ALARM = "nux-connect-poll";
const ERROR_SERVER = -32000;

function activeNetwork(): NuxNetwork {
  // Testnet-first: the active network is the default network. Network
  // switching arrives together with mainnet enablement, which is gated
  // behind the testnet completion criteria and a security audit.
  return getNetwork(DEFAULT_NETWORK_ID);
}

/** Primary address of the wallet on the active network, if a vault exists. */
async function walletPrimaryAddress(): Promise<string | null> {
  const publics = await loadAccountPublics();
  if (!publics) return null;
  return primaryAddress(publics[activeNetwork().id], activeNetwork());
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

async function openApprovalWindow(
  origin: string,
  kind: ApprovalKind,
  tabId: number | undefined,
  extras: ApprovalExtras,
): Promise<unknown> {
  const pending: PendingRequest = {
    id: crypto.randomUUID(),
    origin,
    kind,
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

  return openApprovalWindow(origin, "connect", tabId, {});
}

async function handleSendTransaction(
  origin: string,
  params: unknown,
  tabId: number | undefined,
): Promise<unknown> {
  await requireConnectedAndWallet(origin);
  if (pendingByOrigin.has(origin)) throw busyError();
  const { to, amount, feeRate: givenRate } = parseSendParams(params);

  const network = activeNetwork();
  const publics = await loadAccountPublics();
  if (!publics) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  const client = new ElectrsClient(network);
  let state;
  try {
    state = await discoverWallet(client, publics[network.id], network);
  } catch (error) {
    throw new ProviderRpcError(
      ERROR_SERVER,
      `Could not read the wallet's UTXOs: ${
        error instanceof Error ? error.message : "network error"
      }`,
    );
  }
  const networkRate = await client.getFeeRate();
  const feeRate =
    givenRate ??
    Math.min(MAX_FEE_RATE, Math.max(1, Math.round(networkRate)));
  let draft: SendDraft;
  try {
    draft = buildSendTransaction({
      utxos: state.utxos,
      to,
      amount,
      feeRate,
      network,
      changeAddress: state.changeAddress.address,
    });
  } catch (error) {
    if (error instanceof TxError) throw txErrorToRpc(error);
    throw error;
  }
  return openApprovalWindow(origin, "send", tabId, {
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
  return openApprovalWindow(origin, "signMessage", tabId, { message });
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
  const network = activeNetwork();
  const publics = await loadAccountPublics();
  if (!publics) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  const client = new ElectrsClient(network);
  let state;
  try {
    state = await discoverWallet(client, publics[network.id], network);
  } catch (error) {
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
  return openApprovalWindow(origin, broadcast ? "sendPsbt" : "signPsbt", tabId, {
    psbtBase64,
    psbtSummary: summary,
    psbtOwnership: owned,
  });
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
      return activeNetwork().id;

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
      const client = new ElectrsClient(activeNetwork());
      const [confirmed, unconfirmed] = await Promise.all([
        client.getConfirmedBalance(address),
        client.getUnconfirmedBalance(address),
      ]);
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
  const network = activeNetwork();
  switch (pending.kind) {
    case "connect": {
      const address = await walletPrimaryAddress();
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
      return new ElectrsClient(network).broadcastTx(hex);
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
      return new ElectrsClient(network).broadcastTx(hex);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal (extension page) requests

interface InternalStatus {
  network: NuxNetwork["id"];
  networkLabel: string;
  locked: boolean;
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
  const network = activeNetwork();
  const client = new ElectrsClient(network);
  const status: InternalStatus = {
    network: network.id,
    networkLabel: network.label,
    locked: network.locked,
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
    status.tipHeight = await client.getTipHeight();
    status.feeRate = await client.getFeeRate();
    if (status.address) {
      status.confirmedBalance = await client.getConfirmedBalance(status.address);
      status.unconfirmedBalance = await client.getUnconfirmedBalance(
        status.address,
      );
    }
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
    network: activeNetwork().id,
    networkLabel: activeNetwork().label,
    hasVault: await hasVault(),
    unlocked,
    alreadyConnected: await isOriginConnected(pending.origin),
    address: unlocked ? await walletPrimaryAddress() : null,
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
}

type InternalHandler = (message: InternalMessage) => Promise<unknown>;

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
  disconnectOrigin: async (message) => {
    const origin = message.origin ?? "";
    await removeConnection(origin);
    await emitAccountsChanged(origin);
    return { connections: await listConnections() };
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
  // Periodic wake-up: drives the vault auto-lock check now, and the
  // incoming-coin notification polling in a later milestone.
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  void (async () => {
    if (await checkAutoLock()) {
      await emitAccountsChangedEverywhere();
    }
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

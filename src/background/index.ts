// Background service worker: the core of the extension.
//
// Responsibilities:
// - Route provider requests coming from content scripts, enforcing the
//   origin gating: read methods answer only for connected origins, and
//   account data is only exposed while the vault is unlocked.
// - Own connection approvals: `nux_requestAccounts` opens the approval
//   window, and only an explicit approval there records the origin in
//   the connected-origins store (src/lib/connections.ts) and answers
//   with the accounts. Closing the window or rejecting settles the
//   request with error 4001, as EIP-1193 prescribes.
// - Own the vault lifecycle (create, import, unlock, lock, auto-lock)
//   on behalf of the popup. Secrets never leave this context: the popup
//   receives the freshly generated mnemonic exactly once (at creation)
//   and addresses afterwards; pages receive only what the provider
//   methods define.
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
import { primaryAddress } from "../lib/keys";
import { DEFAULT_NETWORK_ID, getNetwork, type NuxNetwork } from "../lib/networks";
import {
  ERROR_UNAUTHORIZED,
  ERROR_UNSUPPORTED_METHOD,
  ERROR_USER_REJECTED,
  ProviderRpcError,
  isKnownMethod,
  type ProviderRequest,
} from "../lib/rpc";
import {
  VaultError,
  checkAutoLock,
  createVault,
  hasVault,
  importVault,
  isUnlocked,
  loadAccountPublics,
  lockVault,
  touchSession,
  unlockVault,
} from "../lib/vault";

const POLL_ALARM = "nux-connect-poll";

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
// The background remembers which tabs each origin has called from (in
// memory only; the map is rebuilt as pages make requests and is empty
// again after a service-worker restart). Events are sent to those tabs
// on a best-effort basis.

const knownTabsByOrigin = new Map<string, Set<number>>();

function rememberTab(origin: string, tabId: number | undefined): void {
  if (tabId === undefined) return;
  let tabs = knownTabsByOrigin.get(origin);
  if (!tabs) {
    tabs = new Set();
    knownTabsByOrigin.set(origin, tabs);
  }
  tabs.add(tabId);
}

function sendEventToTab(tabId: number, event: string, args: unknown[]): void {
  try {
    const sent = chrome.tabs.sendMessage(tabId, {
      kind: "nux-provider-event",
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
  for (const tabId of knownTabsByOrigin.get(origin) ?? []) {
    sendEventToTab(tabId, "accountsChanged", [accounts]);
  }
}

async function emitAccountsChangedEverywhere(): Promise<void> {
  for (const origin of knownTabsByOrigin.keys()) {
    await emitAccountsChanged(origin);
  }
}

// ---------------------------------------------------------------------------
// Connection approvals
//
// A pending approval lives only in this worker's memory: it is the
// promise behind one `nux_requestAccounts` call, plus the approval
// window that will settle it. If the worker restarts while a window is
// open, the promise is gone with it; the window then reports that the
// request is no longer pending and the page can simply ask again. The
// durable fact — which origins are connected — is the storage record,
// never this map.

interface PendingApproval {
  id: string;
  origin: string;
  windowId: number | null;
  settled: boolean;
  resolve: (accounts: string[]) => void;
  reject: (error: ProviderRpcError) => void;
}

const pendingById = new Map<string, PendingApproval>();
const pendingByOrigin = new Map<string, PendingApproval>();

function settleApproval(
  pending: PendingApproval,
  outcome: { accounts: string[] } | { error: ProviderRpcError },
  closeWindow: boolean,
): void {
  if (pending.settled) return;
  pending.settled = true;
  pendingById.delete(pending.id);
  if (pendingByOrigin.get(pending.origin) === pending) {
    pendingByOrigin.delete(pending.origin);
  }
  if ("accounts" in outcome) {
    pending.resolve(outcome.accounts);
  } else {
    pending.reject(outcome.error);
  }
  if (closeWindow && pending.windowId !== null) {
    void chrome.windows.remove(pending.windowId).catch(() => {
      // The window may already be gone.
    });
  }
}

function rejectApproval(pending: PendingApproval, closeWindow: boolean): void {
  settleApproval(
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

async function handleRequestAccounts(
  origin: string,
  tabId: number | undefined,
): Promise<string[]> {
  if (!(await hasVault())) {
    throw new ProviderRpcError(
      ERROR_UNAUTHORIZED,
      "No wallet exists yet. Create one from the extension popup first.",
    );
  }

  // One approval per origin at a time: a repeated call joins the
  // pending request instead of stacking approval windows.
  const existing = pendingByOrigin.get(origin);
  if (existing) {
    if (existing.windowId !== null) {
      void chrome.windows
        .update(existing.windowId, { focused: true })
        .catch(() => {});
    }
    return new Promise<string[]>((resolve, reject) => {
      const priorResolve = existing.resolve;
      const priorReject = existing.reject;
      existing.resolve = (accounts) => {
        priorResolve(accounts);
        resolve(accounts);
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

  const pending: PendingApproval = {
    id: crypto.randomUUID(),
    origin,
    windowId: null,
    settled: false,
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<string[]>((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  pendingById.set(pending.id, pending);
  pendingByOrigin.set(origin, pending);
  rememberTab(origin, tabId);

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
      // Settled while the window was being created (e.g. resolved by a
      // duplicate path); do not leave a stray window behind.
      void chrome.windows.remove(pending.windowId).catch(() => {});
    }
  } catch {
    rejectApproval(pending, false);
  }
  return promise;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const pending of pendingById.values()) {
    if (pending.windowId === windowId) {
      // Closing the approval window without a decision is a rejection.
      rejectApproval(pending, false);
      break;
    }
  }
});

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
  rememberTab(origin, tabId);

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
    case "nux_signMessage":
    case "nux_signPsbt":
    case "nux_sendPsbt":
      // Known methods whose implementation belongs to a later milestone
      // (transactions and signing, after connection approvals).
      // Rejected honestly instead of silently failing.
      throw new ProviderRpcError(
        ERROR_UNSUPPORTED_METHOD,
        `Method not implemented yet in this milestone: ${request.method}`,
      );

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
  network: NuxNetwork["id"];
  networkLabel: string;
  hasVault: boolean;
  unlocked: boolean;
  alreadyConnected: boolean;
  /** The address that will be shared; shown only while unlocked. */
  address: string | null;
}

async function handleGetApprovalRequest(id: string): Promise<ApprovalRequestView> {
  const pending = pendingById.get(id);
  if (!pending) {
    throw new ProviderRpcError(
      -32000,
      "This approval request is no longer pending.",
    );
  }
  const unlocked = await isUnlocked();
  return {
    id: pending.id,
    origin: pending.origin,
    network: activeNetwork().id,
    networkLabel: activeNetwork().label,
    hasVault: await hasVault(),
    unlocked,
    alreadyConnected: await isOriginConnected(pending.origin),
    address: unlocked ? await walletPrimaryAddress() : null,
  };
}

async function handleResolveApproval(
  id: string,
  approved: boolean,
): Promise<{ resolved: true }> {
  const pending = pendingById.get(id);
  if (!pending) {
    throw new ProviderRpcError(
      -32000,
      "This approval request is no longer pending.",
    );
  }
  if (!approved) {
    rejectApproval(pending, true);
    return { resolved: true };
  }
  if (!(await isUnlocked())) {
    // The vault may have auto-locked while the window was open; the
    // approval page falls back to its unlock form on this error.
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "The wallet is locked.");
  }
  const address = await walletPrimaryAddress();
  if (!address) {
    throw new ProviderRpcError(ERROR_UNAUTHORIZED, "No wallet exists yet.");
  }
  await connectOrigin(pending.origin, [address]);
  await touchSession();
  settleApproval(pending, { accounts: [address] }, true);
  await emitAccountsChanged(pending.origin);
  return { resolved: true };
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
          error: { code: -32000, message: error.message },
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

// Background service worker: the core of the extension.
//
// Responsibilities:
// - Route provider requests coming from content scripts, enforcing the
//   origin gating: read methods answer only for connected origins, and
//   account data is only exposed while the vault is unlocked.
// - Own the vault lifecycle (create, import, unlock, lock, auto-lock)
//   on behalf of the popup. Secrets never leave this context: the popup
//   receives the freshly generated mnemonic exactly once (at creation)
//   and addresses afterwards; pages receive only what the provider
//   methods define.
// - Serve popup status: network, tip height, fee rate, and — when a
//   wallet exists — the primary address and its balances, all from the
//   active network's own electrs instance.

import "../lib/globals";
import { ElectrsClient } from "../lib/electrs";
import { primaryAddress } from "../lib/keys";
import { DEFAULT_NETWORK_ID, getNetwork, type NuxNetwork } from "../lib/networks";
import {
  ERROR_UNAUTHORIZED,
  ERROR_UNSUPPORTED_METHOD,
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

const CONNECTED_ORIGINS_KEY = "connectedOrigins";
const POLL_ALARM = "nux-connect-poll";

function activeNetwork(): NuxNetwork {
  // Testnet-first: the active network is the default network. Network
  // switching arrives together with mainnet enablement, which is gated
  // behind the testnet completion criteria and a security audit.
  return getNetwork(DEFAULT_NETWORK_ID);
}

async function getConnectedOrigins(): Promise<Record<string, string[]>> {
  const stored = await chrome.storage.local.get(CONNECTED_ORIGINS_KEY);
  const value = stored[CONNECTED_ORIGINS_KEY];
  if (value && typeof value === "object") {
    return value as Record<string, string[]>;
  }
  return {};
}

async function isOriginConnected(origin: string): Promise<boolean> {
  const origins = await getConnectedOrigins();
  return Object.prototype.hasOwnProperty.call(origins, origin);
}

/** Primary address of the wallet on the active network, if a vault exists. */
async function walletPrimaryAddress(): Promise<string | null> {
  const publics = await loadAccountPublics();
  if (!publics) return null;
  return primaryAddress(publics[activeNetwork().id], activeNetwork());
}

async function handleProviderRequest(
  origin: string,
  request: ProviderRequest,
): Promise<unknown> {
  if (!request || typeof request.method !== "string") {
    throw new ProviderRpcError(ERROR_UNSUPPORTED_METHOD, "Malformed request.");
  }

  switch (request.method) {
    case "nux_getNetwork":
      return activeNetwork().id;

    case "nux_getAccounts": {
      // Origin gating (locked decision): only connected origins receive
      // an answer, and accounts are exposed only while unlocked. Every
      // other state answers with an empty list.
      if (!(await isOriginConnected(origin))) return [];
      if (!(await isUnlocked())) return [];
      const address = await walletPrimaryAddress();
      if (!address) return [];
      await touchSession();
      return [address];
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

    case "nux_requestAccounts":
    case "nux_sendTransaction":
    case "nux_signMessage":
    case "nux_signPsbt":
    case "nux_sendPsbt":
      // Known methods whose implementation belongs to a later milestone
      // (connection approvals next, then transactions and signing).
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

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith("chrome-extension://")
  );
}

type InternalHandler = (message: {
  password?: string;
  mnemonic?: string;
}) => Promise<unknown>;

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
    return { unlocked: true };
  },
  vaultLock: async () => {
    await lockVault();
    return { unlocked: false };
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
  void checkAutoLock();
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
      return handleProviderRequest(origin, message.request as ProviderRequest);
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

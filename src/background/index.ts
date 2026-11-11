// Background service worker: the core of the extension.
//
// Responsibilities in this milestone (scaffold):
// - Route provider requests coming from content scripts.
// - Answer `nux_getNetwork` from the locked network configuration
//   (testnet-first: mainnet is configured but locked).
// - Enforce origin gating: read methods answer only for connected
//   origins; an unconnected origin receives an empty account list.
// - Serve the popup status request (network, tip height, fee rate)
//   through the electrs client of the active network.
// - Register the periodic alarm that the incoming-coin notification
//   polling (a later milestone) will use.
//
// Deliberately not present yet: the vault, account creation, approvals,
// transaction building, and signing. Provider methods that are known but
// not implemented in this milestone are rejected with code 4200 and a
// message that says so; unknown methods are rejected with 4200 as well.

import { ElectrsClient } from "../lib/electrs";
import { DEFAULT_NETWORK_ID, getNetwork, type NuxNetwork } from "../lib/networks";
import {
  ERROR_UNAUTHORIZED,
  ERROR_UNSUPPORTED_METHOD,
  ProviderRpcError,
  isKnownMethod,
  type ProviderRequest,
} from "../lib/rpc";

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
      // an answer. Until the vault milestone there are no accounts, so
      // both branches currently produce an empty list.
      if (!(await isOriginConnected(origin))) {
        return [];
      }
      return [];
    }

    case "nux_requestAccounts":
    case "nux_getBalance":
    case "nux_sendTransaction":
    case "nux_signMessage":
    case "nux_signPsbt":
    case "nux_sendPsbt":
      // Known methods whose implementation belongs to a later milestone
      // (vault first). Rejected honestly instead of silently failing.
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
  };
  try {
    status.tipHeight = await client.getTipHeight();
    status.feeRate = await client.getFeeRate();
  } catch (error) {
    status.statusError =
      error instanceof Error ? error.message : "electrs unreachable";
  }
  return status;
}

chrome.runtime.onInstalled.addListener(() => {
  // Session storage holds the vault decryption key while the vault is
  // unlocked (a later milestone). Restrict it to trusted contexts from
  // the start so no web page context can ever read it.
  try {
    void chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Older Chrome versions: access level defaults apply.
  }
  // Periodic wake-up used by the incoming-coin notification polling.
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  // Notification polling arrives with the wallet milestone. For now the
  // alarm only proves the wake-up wiring; it performs no user-visible
  // action and watches no addresses yet.
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
    if (message?.kind === "nux-internal" && message.request === "getStatus") {
      return handleGetStatus();
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

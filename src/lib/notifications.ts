// Incoming-coin watcher (Revisi 1, Butir 8).
//
// A poller, not a push server: the 1-minute alarm wakes the service
// worker, which checks the electrs instance for new UTXOs on the
// watched receive-chain addresses and compares them against the
// txids it has already seen (chrome.storage.local). A new external
// UTXO fires one system notification at mempool sighting, and a
// second one when it confirms (two notifications, different status):
// scheduled mining makes the gap between sighting and confirmation
// long, so the confirmation needs its own announcement.
//
// Gentleness is a design requirement, learned from the Milestone 4
// rate-limit saga: a poll reads only the watched addresses' UTXO
// lists (normally one request per minute), never a full gap-limit
// discovery scan. The watched list comes from the last wallet
// discovery (primary receive address plus any used receive address),
// and the owned-address set for the anti-change rule comes from the
// cached discovery state, so a poll costs no scan at all after the
// first.
//
// The watcher works while the vault is locked: everything it touches
// is public (addresses, UTXOs, transaction inputs). Nothing secret
// ever enters a notification.

import type { ElectrsClient } from "./electrs";
import type { NuxNetwork } from "./networks";
import type { WalletState } from "./wallet";

const WATCHED_ADDRESSES_KEY = "notificationWatchAddresses";
const SEEN_KEY = "notificationSeen";
const ENABLED_KEY = "notificationsEnabled";

/** At most this many activity entries are kept; the oldest go first. */
const MAX_SEEN_ENTRIES = 50;

export type ActivityStatus = "pending" | "confirmed" | "internal";

export interface ActivityEntry {
  key: string;
  txid: string;
  vout: number;
  address: string;
  amount: number;
  status: ActivityStatus;
  firstSeenAt: number;
  confirmedAt?: number;
}

export interface NotificationCheckResult {
  checked: boolean;
  newExternal: number;
  flippedToConfirmed: number;
  pendingCount: number;
}

async function loadSeen(): Promise<Record<string, ActivityEntry>> {
  const stored = await chrome.storage.local.get(SEEN_KEY);
  const value = stored[SEEN_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, ActivityEntry>)
    : {};
}

async function saveSeen(seen: Record<string, ActivityEntry>): Promise<void> {
  const entries = Object.values(seen).sort(
    (a, b) => a.firstSeenAt - b.firstSeenAt,
  );
  const trimmed = entries.slice(-MAX_SEEN_ENTRIES);
  const next: Record<string, ActivityEntry> = {};
  for (const entry of trimmed) next[entry.key] = entry;
  await chrome.storage.local.set({ [SEEN_KEY]: next });
}

/** The activity list, newest first. */
export async function getActivityEntries(): Promise<ActivityEntry[]> {
  const seen = await loadSeen();
  return Object.values(seen).sort((a, b) => b.firstSeenAt - a.firstSeenAt);
}

export async function isNotificationsEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  const value = stored[ENABLED_KEY];
  // Default on (locked decision); the popup toggle writes false.
  return value === undefined ? true : value === true;
}

export async function setNotificationsEnabled(
  enabled: boolean,
): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

/**
 * Remember the receive-chain addresses worth polling: the primary
 * address plus every used receive address from the last discovery.
 * Called whenever a fresh discovery runs (sends, PSBT requests, and
 * the watcher's first pass); polls then read only this list.
 */
export async function updateWatchedAddresses(
  state: WalletState,
): Promise<void> {
  const watched = state.addresses
    .filter((entry) => entry.chain === 0 && (entry.used || entry.index === 0))
    .map((entry) => entry.address);
  await chrome.storage.local.set({ [WATCHED_ADDRESSES_KEY]: watched });
}

async function loadWatchedAddresses(): Promise<string[]> {
  const stored = await chrome.storage.local.get(WATCHED_ADDRESSES_KEY);
  const value = stored[WATCHED_ADDRESSES_KEY];
  return Array.isArray(value) ? (value as string[]) : [];
}

function networkTag(network: NuxNetwork): string {
  return network.id === "testnet" ? "TESTNET" : "MAINNET";
}

async function notifyIncoming(
  network: NuxNetwork,
  entry: ActivityEntry,
  stage: "pending" | "confirmed",
): Promise<void> {
  // Each stage gets its own notification id, so the confirmation
  // appears as a second, separate notification instead of silently
  // replacing the mempool one.
  const id =
    stage === "confirmed" ? `confirmed:${entry.key}` : `incoming:${entry.key}`;
  const message =
    stage === "confirmed"
      ? `+${entry.amount} nusan — terkonfirmasi`
      : `+${entry.amount} nusan — menunggu konfirmasi`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: `[${networkTag(network)}] NUX masuk`,
    message,
    priority: 1,
  });
}

async function setBadge(pendingCount: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#0a5c42" });
    await chrome.action.setBadgeText({
      text: pendingCount > 0 ? String(pendingCount) : "",
    });
  } catch {
    // The badge is a courtesy; a failure must not break the check.
  }
}

/** Clear the toolbar badge (called when the popup is opened). */
export async function clearBadge(): Promise<void> {
  await setBadge(0);
}

export async function runNotificationCheck(args: {
  client: ElectrsClient;
  network: NuxNetwork;
  primaryAddress: string | null;
  getWalletState: () => Promise<WalletState>;
}): Promise<NotificationCheckResult> {
  const { client, network, getWalletState } = args;
  const empty: NotificationCheckResult = {
    checked: false,
    newExternal: 0,
    flippedToConfirmed: 0,
    pendingCount: 0,
  };
  if (!args.primaryAddress) return empty;

  const state = await getWalletState();
  const owned = new Set(state.addresses.map((entry) => entry.address));
  await updateWatchedAddresses(state);
  const watched = await loadWatchedAddresses();
  const addresses = watched.length > 0 ? watched : [args.primaryAddress];
  const enabled = await isNotificationsEnabled();
  const seen = await loadSeen();
  let newExternal = 0;
  let flippedToConfirmed = 0;

  for (const address of addresses) {
    const utxos = await client.getAddressUtxos(address);
    for (const utxo of utxos) {
      const key = `${utxo.txid}:${utxo.vout}`;
      const existing = seen[key];
      if (existing) {
        // Flip a pending entry to confirmed and fire the second
        // notification (same amount, "terkonfirmasi" status). The
        // flip can only happen once per entry, so the second
        // notification cannot repeat.
        if (
          existing.status === "pending" &&
          utxo.status.confirmed
        ) {
          existing.status = "confirmed";
          existing.confirmedAt = Date.now();
          flippedToConfirmed += 1;
          if (enabled) {
            await notifyIncoming(network, existing, "confirmed");
          }
        }
        continue;
      }

      // New sighting. The anti-change rule (mandatory): the creating
      // transaction must spend NO input from one of the wallet's own
      // addresses. A coinbase (no inputs at all) passes by definition.
      const detail = await client.getTx(utxo.txid);
      const internal = detail.vin.some(
        (input) =>
          input.prevout?.scriptpubkey_address !== undefined &&
          owned.has(input.prevout.scriptpubkey_address),
      );
      const entry: ActivityEntry = {
        key,
        txid: utxo.txid,
        vout: utxo.vout,
        address,
        amount: utxo.value,
        status: internal
          ? "internal"
          : utxo.status.confirmed
            ? "confirmed"
            : "pending",
        firstSeenAt: Date.now(),
      };
      seen[key] = entry;
      if (!internal) {
        newExternal += 1;
        if (enabled) {
          // An arrival first seen already confirmed fires its single
          // notification with the "confirmed" stage; a mempool
          // sighting fires the "pending" one and the confirmation
          // follows later as the second notification.
          await notifyIncoming(
            network,
            entry,
            entry.status === "confirmed" ? "confirmed" : "pending",
          );
        }
      }
    }
  }

  await saveSeen(seen);
  const pendingCount = Object.values(seen).filter(
    (entry) => entry.status === "pending",
  ).length;
  if (enabled) {
    await setBadge(pendingCount);
  }
  return {
    checked: true,
    newExternal,
    flippedToConfirmed,
    pendingCount,
  };
}

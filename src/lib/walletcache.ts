// Persistent offline UTXO cache (Milestone 9, PUNDI-style).
//
// A full discovery scan costs dozens of electrs requests, and building
// a send from a cold scan kept the popup on "Preparing…" for 10-40
// seconds with no feedback (field finding). The discovered wallet
// state — used addresses, confirmed UTXOs, first-unused change
// address, aggregated balances — is therefore kept in
// chrome.storage.local, where it survives browser restarts, and sends
// build from it immediately. The cache is refreshed in the background
// (the 1-minute alarm, the popup's status reads when stale, and after
// every own broadcast), and the selected inputs are verified against
// the network before signing, so a stale cache can delay a send but
// never cause a double-spend.
//
// The cached data is public (addresses, outpoints, amounts); no keys
// or secrets are ever stored here.

import type { SendSummary } from "./tx";
import type { WalletState } from "./wallet";

export interface WalletCacheRecord {
  /** Unix ms of the last full sync (or optimistic broadcast update). */
  syncedAt: number;
  /** Tip height observed at the last sync. */
  tipHeight: number;
  /** The discovered wallet state. */
  state: WalletState;
  /** Aggregated balances at the last sync. */
  confirmed: number;
  unconfirmed: number;
}

export function walletCacheKey(
  networkId: string,
  primaryAddress: string,
): string {
  return `walletCache:${networkId}:${primaryAddress}`;
}

function isWalletCacheRecord(value: unknown): value is WalletCacheRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["syncedAt"] !== "number") return false;
  if (typeof record["tipHeight"] !== "number") return false;
  if (typeof record["confirmed"] !== "number") return false;
  if (typeof record["unconfirmed"] !== "number") return false;
  const state = record["state"] as Record<string, unknown> | undefined;
  if (typeof state !== "object" || state === null) return false;
  if (!Array.isArray(state["addresses"]) || !Array.isArray(state["utxos"])) {
    return false;
  }
  if (
    typeof state["changeAddress"] !== "object" ||
    state["changeAddress"] === null
  ) {
    return false;
  }
  return true;
}

/** Read the cache record; null when absent or malformed. */
export async function readWalletCache(
  networkId: string,
  primaryAddress: string,
): Promise<WalletCacheRecord | null> {
  const key = walletCacheKey(networkId, primaryAddress);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return isWalletCacheRecord(value) ? value : null;
}

export async function writeWalletCache(
  networkId: string,
  primaryAddress: string,
  record: WalletCacheRecord,
): Promise<void> {
  await chrome.storage.local.set({
    [walletCacheKey(networkId, primaryAddress)]: record,
  });
}

/**
 * Apply an own broadcast to a cache record, optimistically: the spent
 * inputs leave the UTXO set at once, the change address is marked used
 * and the change pointer advances to the next unused change address,
 * and the unconfirmed balance drops by amount + fee (the confirmed
 * balance is untouched — the spend is unconfirmed until it mines).
 * The change output itself is unconfirmed, so it is not added to the
 * spendable set; the next background sync picks it up. Pure: returns
 * a new record, the input is untouched.
 */
export function applyOwnBroadcast(
  record: WalletCacheRecord,
  summary: SendSummary,
): WalletCacheRecord {
  const spentKeys = new Set(
    summary.inputs.map((input) => `${input.txid}:${input.vout}`),
  );
  const utxos = record.state.utxos.filter(
    (utxo) => !spentKeys.has(`${utxo.txid}:${utxo.vout}`),
  );
  const addresses = record.state.addresses.map((entry) => ({ ...entry }));
  let changeAddress = record.state.changeAddress;
  if (summary.changeAddress !== null && summary.changeValue > 0) {
    const usedEntry = addresses.find(
      (entry) => entry.address === summary.changeAddress,
    );
    if (usedEntry) usedEntry.used = true;
    const next = addresses.find(
      (entry) => entry.chain === 1 && !entry.used,
    );
    if (next) changeAddress = next;
  }
  return {
    ...record,
    syncedAt: Date.now(),
    state: {
      ...record.state,
      addresses,
      utxos,
      spendableBalance: utxos.reduce((sum, utxo) => sum + utxo.value, 0),
      changeAddress,
    },
    unconfirmed: record.unconfirmed - summary.amount - summary.fee,
  };
}

// The current receive address: which receive-chain address the popup
// shows for receiving. The wallet is BIP84 HD, so a fresh address is
// always one derivation away; reusing one address for every payment
// leaks the wallet's whole incoming history to every payer. The
// refresh button advances to the next UNUSED receive address, and the
// pointer is persisted per network + wallet so it survives restarts.
//
// Two bounds guard the pointer. It never leaves the discovered set:
// discovery scans each chain only up to the gap limit past the last
// used address, so an address beyond the discovered tail could receive
// funds the wallet never sees. And it never changes the dApp-facing
// account, which stays the primary address (receive index 0); only
// the displayed receive address moves.

import type { WalletState } from "./wallet";

export function receiveAddressIndexKey(
  networkId: string,
  primaryAddress: string,
): string {
  return `receiveAddressIndex:${networkId}:${primaryAddress}`;
}

export async function readReceiveAddressIndex(
  networkId: string,
  primaryAddress: string,
): Promise<number> {
  const key = receiveAddressIndexKey(networkId, primaryAddress);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : 0;
}

export async function writeReceiveAddressIndex(
  networkId: string,
  primaryAddress: string,
  index: number,
): Promise<void> {
  await chrome.storage.local.set({
    [receiveAddressIndexKey(networkId, primaryAddress)]: index,
  });
}

/** The receive-chain entries of a discovered state, in index order. */
export function receiveAddresses(
  state: WalletState,
): { address: string; index: number; used: boolean }[] {
  return state.addresses
    .filter((entry) => entry.chain === 0)
    .map((entry) => ({
      address: entry.address,
      index: entry.index,
      used: entry.used,
    }));
}

/** Resolve the current receive address: the entry at the pointer,
 * clamped to the last discovered receive address. */
export function currentReceiveAddress(
  state: WalletState,
  index: number,
): { address: string; index: number } {
  const receive = receiveAddresses(state);
  const clamped = Math.min(Math.max(index, 0), receive.length - 1);
  const entry = receive[clamped];
  if (!entry) throw new Error("No receive address discovered.");
  return { address: entry.address, index: entry.index };
}

/** The next UNUSED receive index after the pointer, or null when the
 * discovered set holds no further unused receive address. */
export function nextUnusedReceiveIndex(
  state: WalletState,
  currentIndex: number,
): number | null {
  for (const entry of receiveAddresses(state)) {
    if (entry.index > currentIndex && !entry.used) return entry.index;
  }
  return null;
}

// Wallet discovery: which of the account's addresses exist on chain,
// and which confirmed UTXOs the wallet can spend.
//
// The account's addresses are derived from the stored account public
// data (no secrets), scanning the receive chain (0) and the change
// chain (1) from index 0 with the standard BIP44 gap limit: scanning a
// chain stops after GAP_LIMIT consecutive addresses with no transaction
// history at all. Every scanned address is one the wallet owns —
// including the unused tail after the last used address, which is where
// fresh change addresses come from and what PSBT input ownership is
// checked against.
//
// Only confirmed UTXOs (>= 1 confirmation) are spendable. Unconfirmed
// coins — including this wallet's own not-yet-confirmed change — wait
// for a confirmation before they can fund a new transaction; that keeps
// the transaction engine free of unconfirmed-parent chains.

import type { ElectrsClient, Utxo } from "./electrs";
import { deriveAddress, type AccountPublic } from "./keys";
import type { NuxNetwork } from "./networks";

export const GAP_LIMIT = 20;

export interface OwnedAddress {
  address: string;
  chain: 0 | 1;
  index: number;
  /** True once the address has any on-chain or mempool history. */
  used: boolean;
}

export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
  address: string;
  chain: 0 | 1;
  index: number;
}

export interface WalletState {
  /** Every scanned address on both chains, in derivation order. */
  addresses: OwnedAddress[];
  /** Confirmed, spendable UTXOs across both chains. */
  utxos: WalletUtxo[];
  /** Sum of the spendable UTXOs, in nusan. */
  spendableBalance: number;
  /** First unused change-chain address; where new change goes. */
  changeAddress: OwnedAddress;
}

async function discoverChain(
  client: ElectrsClient,
  accountPublic: AccountPublic,
  network: NuxNetwork,
  chain: 0 | 1,
): Promise<{ addresses: OwnedAddress[]; utxos: WalletUtxo[] }> {
  const addresses: OwnedAddress[] = [];
  const utxos: WalletUtxo[] = [];
  let gap = 0;
  for (let index = 0; gap < GAP_LIMIT; index++) {
    const address = deriveAddress(accountPublic, network, chain, index);
    const info = await client.getAddressInfo(address);
    const used =
      info.chainStats.txCount + info.mempoolStats.txCount > 0;
    addresses.push({ address, chain, index, used });
    if (!used) {
      gap += 1;
      continue;
    }
    gap = 0;
    const found: Utxo[] = await client.getAddressUtxos(address);
    for (const utxo of found) {
      if (!utxo.status.confirmed) continue;
      utxos.push({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        address,
        chain,
        index,
      });
    }
  }
  return { addresses, utxos };
}

export async function discoverWallet(
  client: ElectrsClient,
  accountPublic: AccountPublic,
  network: NuxNetwork,
): Promise<WalletState> {
  const receive = await discoverChain(client, accountPublic, network, 0);
  const change = await discoverChain(client, accountPublic, network, 1);
  // The scan always ends with an unused tail (the gap limit), so a
  // first-unused change address exists; fall back to the last scanned
  // address in the unreachable contrary case.
  const changeAddress =
    change.addresses.find((entry) => !entry.used) ??
    change.addresses[change.addresses.length - 1];
  if (!changeAddress) {
    throw new Error("Change address discovery failed.");
  }
  const utxos = [...receive.utxos, ...change.utxos];
  return {
    addresses: [...receive.addresses, ...change.addresses],
    utxos,
    spendableBalance: utxos.reduce((sum, utxo) => sum + utxo.value, 0),
    changeAddress,
  };
}

/** Lookup of derivation positions by address, for signing. */
export function ownershipMap(
  state: WalletState,
): Map<string, { chain: 0 | 1; index: number }> {
  return new Map(
    state.addresses.map((entry) => [
      entry.address,
      { chain: entry.chain, index: entry.index },
    ]),
  );
}

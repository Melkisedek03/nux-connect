// Nusacoin network parameters.
//
// Mainnet values are verified against Nusacoin Core `src/chainparams.cpp`
// and the existing web wallet. Testnet values are verified against the
// testnet class in the same file. The BIP44 coin type is a wallet
// convention, not a daemon constant: 662 on mainnet; on testnet the
// BIP44/SLIP-0044 convention reserves coin type 1 for all testnets, and
// that convention is used here (it is not defined by chainparams).
//
// Derivation paths are written out in full on purpose. An implementer
// must never have to guess them:
//   receive: m/84'/<coinType>'/0'/0/<index>
//   change:  m/84'/<coinType>'/0'/1/<index>
// Both indices start at 0.

export interface NuxNetwork {
  id: "mainnet" | "testnet";
  /** Human-readable label shown in the UI. Testnet is always explicit. */
  label: string;
  bech32Hrp: string;
  coinType: number;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
  /** Esplora-style REST base URL of the electrs instance for this network. */
  electrsBaseUrl: string;
  dustLimit: number;
}

export const MAINNET: NuxNetwork = {
  id: "mainnet",
  label: "Mainnet",
  bech32Hrp: "nu",
  coinType: 662,
  pubKeyHash: 0x35,
  scriptHash: 0x4b,
  wif: 0x57,
  electrsBaseUrl: "https://apinux.taobot.org",
  dustLimit: 546,
};

export const TESTNET: NuxNetwork = {
  id: "testnet",
  label: "Testnet",
  bech32Hrp: "tn",
  coinType: 1,
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
  electrsBaseUrl: "https://apinuxtest.taobot.org",
  dustLimit: 546,
};

export const NETWORKS: Record<NuxNetwork["id"], NuxNetwork> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

/** The active network is a user setting in chrome.storage.local,
 * owned by the background like every other setting; the popup
 * switches it through an internal message. Testnet stays the
 * default: a new user lands on testnet, and mainnet is an explicit
 * switch (with a one-time acknowledgment on the first switch). */
export const ACTIVE_NETWORK_KEY = "activeNetwork";

/** Anything that is not exactly "mainnet" reads as the default
 * testnet, so a missing or corrupted stored value never lands the
 * user on mainnet by accident. */
export function parseNetworkId(value: unknown): NuxNetwork["id"] {
  return value === "mainnet" ? "mainnet" : "testnet";
}

export async function readActiveNetworkId(): Promise<NuxNetwork["id"]> {
  const stored = await chrome.storage.local.get([ACTIVE_NETWORK_KEY]);
  return parseNetworkId(stored[ACTIVE_NETWORK_KEY]);
}

export async function writeActiveNetworkId(
  id: NuxNetwork["id"],
): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_NETWORK_KEY]: id });
}

/** The MVP is testnet-first: testnet is the default and active network. */
export const DEFAULT_NETWORK_ID: NuxNetwork["id"] = "testnet";

export function getNetwork(id: NuxNetwork["id"]): NuxNetwork {
  return NETWORKS[id];
}

export function receiveDerivationPath(network: NuxNetwork, index: number): string {
  return `m/84'/${network.coinType}'/0'/0/${index}`;
}

export function changeDerivationPath(network: NuxNetwork, index: number): string {
  return `m/84'/${network.coinType}'/0'/1/${index}`;
}

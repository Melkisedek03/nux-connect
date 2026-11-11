// Key and address engine.
//
// The locked library stack is bitcoinjs-lib with bip32 and bip39, using
// @bitcoinerlab/secp256k1 as the ECC backend. That backend is pure
// JavaScript (built on @noble/curves), so the whole stack runs inside a
// Manifest V3 service worker with no WebAssembly and no CSP exception.
// Nusacoin parameters enter bitcoinjs-lib as a custom network object
// built from src/lib/networks.ts; nothing here hardcodes a parameter
// that networks.ts owns.
//
// Derivation paths (never guessed, written out in the specification):
//   account: m/84'/<coinType>'/0'
//   receive: account/0/<index>
//   change:  account/1/<index>

import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";
import * as bip39 from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import type { NuxNetwork } from "./networks";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

/**
 * Extended-key version bytes used for internal serialization only.
 * Testnet uses the standard tpub/tprv pair confirmed in Nusacoin Core
 * chainparams. The mainnet pair below is the standard xpub/xprv pair and
 * is never presented to the user or exported in this milestone; it only
 * lets bip32 construct nodes consistently.
 */
const INTERNAL_BIP32_VERSIONS: Record<
  NuxNetwork["id"],
  { public: number; private: number }
> = {
  mainnet: { public: 0x0488b21e, private: 0x0488ade4 },
  testnet: { public: 0x043587cf, private: 0x04358394 },
};

/** Build the bitcoinjs-lib network object for a Nusacoin network. */
export function toBitcoinJsNetwork(network: NuxNetwork): bitcoin.Network {
  return {
    // Nusacoin Core's MESSAGE_MAGIC from src/util/message.cpp, verbatim.
    // The length prefix is applied by the signing code (as Core does),
    // not embedded here. Message signing itself arrives in a later
    // milestone and implements Core's scheme directly.
    messagePrefix: "Nusacoin Signed Message:\n",
    bech32: network.bech32Hrp,
    bip32: INTERNAL_BIP32_VERSIONS[network.id],
    pubKeyHash: network.pubKeyHash,
    scriptHash: network.scriptHash,
    wif: network.wif,
  };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Hex string must have even length.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Public half of an account node; safe to store and to derive from. */
export interface AccountPublic {
  publicKey: string; // hex, 33 bytes compressed
  chainCode: string; // hex, 32 bytes
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function generateMnemonicPhrase(): string {
  // 128 bits of entropy: a 12-word phrase.
  return bip39.generateMnemonic(128);
}

export function isValidMnemonicPhrase(phrase: string): boolean {
  return bip39.validateMnemonic(normalizeMnemonic(phrase));
}

/**
 * Derive the account-level public data for one network from a mnemonic.
 * The seed and the private account node exist only for the duration of
 * this call; only the public half leaves the function.
 */
export function deriveAccountPublic(
  mnemonic: string,
  network: NuxNetwork,
): AccountPublic {
  const seed = bip39.mnemonicToSeedSync(normalizeMnemonic(mnemonic));
  const root = bip32.fromSeed(seed, toBitcoinJsNetwork(network));
  const account = root.derivePath(`m/84'/${network.coinType}'/0'`);
  return {
    publicKey: toHex(account.publicKey),
    chainCode: toHex(account.chainCode),
  };
}

/**
 * Derive a P2WPKH (native SegWit, bech32) address from stored account
 * public data. `chain` is 0 for the receive chain and 1 for the change
 * chain; indices start at 0. Needs no secret material.
 */
export function deriveAddress(
  accountPublic: AccountPublic,
  network: NuxNetwork,
  chain: 0 | 1,
  index: number,
): string {
  const btcNetwork = toBitcoinJsNetwork(network);
  const accountNode = bip32.fromPublicKey(
    fromHex(accountPublic.publicKey),
    fromHex(accountPublic.chainCode),
    btcNetwork,
  );
  const child = accountNode.derive(chain).derive(index);
  const payment = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network: btcNetwork,
  });
  if (!payment.address) {
    throw new Error("Address derivation failed.");
  }
  return payment.address;
}

/** The wallet's primary address on a network: receive chain, index 0. */
export function primaryAddress(
  accountPublic: AccountPublic,
  network: NuxNetwork,
): string {
  return deriveAddress(accountPublic, network, 0, 0);
}

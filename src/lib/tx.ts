// Transaction engine: coin selection, transaction building, signing,
// PSBT handling, and legacy message signing.
//
// Everything here is deterministic and secret-free except the two
// functions that take a mnemonic (signWalletPsbt, signMessageLegacy);
// those derive per-address keys transiently via src/lib/keys.ts and
// never store or return them.
//
// Locked rules implemented here:
// - Coin selection is largest-first.
// - Change below the network dust limit is folded into the fee.
// - Amounts are integer nusan everywhere.
// - A PSBT's implied fee rate (recalculated by this code, never taken
//   from the requester) must not exceed the fee-rate ceiling; the
//   caller enforces it as a rejection before any approval is shown.
// - A send may signal BIP125 replaceability (RBF) when the sender asks
//   for it; inputs then use nSequence 0xfffffffd. Signalling
//   replaceability does not by itself replace anything.
// - Message signing is Nusacoin Core's legacy scheme exactly, so
//   signatures verify in Core's `verifymessage` and in the web wallet.

import * as ecc from "@bitcoinerlab/secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { Buffer } from "buffer";
import {
  derivePrivateKey,
  toBitcoinJsNetwork,
  toSigner,
  type DerivedKey,
} from "./keys";
import type { NuxNetwork } from "./networks";
import type { WalletUtxo } from "./wallet";

export class TxError extends Error {
  /**
   * "invalid" marks a malformed request (maps to JSON-RPC -32602);
   * "insufficient" marks a funds shortfall; anything else is a plain
   * execution failure. The background maps these onto provider errors.
   */
  readonly kind: "invalid" | "insufficient" | "generic";

  constructor(message: string, kind: TxError["kind"] = "generic") {
    super(message);
    this.name = "TxError";
    this.kind = kind;
  }
}

/** The fee-rate ceiling from the locked decisions (nusan/vbyte). */
export const MAX_FEE_RATE = 546;

/**
 * nSequence signalling BIP125 replaceability (RBF): any value below
 * 0xfffffffe opts in; 0xfffffffd is the conventional choice.
 */
export const RBF_SEQUENCE = 0xfffffffd;

/**
 * Estimated virtual size of a P2WPKH transaction: ~10 vbytes of
 * overhead, ~68 per input (witness included), ~31 per output.
 */
export function estimateVsize(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}

function feeFor(rate: number, inputCount: number, outputCount: number): number {
  return Math.ceil(rate * estimateVsize(inputCount, outputCount));
}

export interface SendInput {
  txid: string;
  vout: number;
  value: number;
  address: string;
}

export interface SendSummary {
  to: string;
  amount: number;
  fee: number;
  feeRate: number;
  /** amount + fee, in nusan. */
  total: number;
  inputs: SendInput[];
  changeAddress: string | null;
  changeValue: number;
  /** Whether the transaction signals BIP125 replaceability. */
  rbf: boolean;
}

export interface SendDraft {
  psbtBase64: string;
  summary: SendSummary;
}

/**
 * Build an unsigned-but-signable PSBT paying `amount` nusan to `to`,
 * funded from the wallet's confirmed UTXOs (largest first), with change
 * to `changeAddress` unless the remainder is dust, in which case it is
 * folded into the fee.
 */
export function buildSendTransaction(args: {
  utxos: WalletUtxo[];
  to: string;
  amount: number;
  feeRate: number;
  network: NuxNetwork;
  changeAddress: string;
  /** Signal BIP125 replaceability on every input (default: off). */
  rbf?: boolean;
}): SendDraft {
  const { network, amount, feeRate, rbf } = args;
  const btcNetwork = toBitcoinJsNetwork(network);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TxError(
      "Amount must be a positive integer number of nusan.",
      "invalid",
    );
  }
  try {
    bitcoin.address.toOutputScript(args.to, btcNetwork);
    bitcoin.address.toOutputScript(args.changeAddress, btcNetwork);
  } catch {
    throw new TxError("An address is not valid for this network.", "invalid");
  }

  const sorted = [...args.utxos].sort((a, b) => b.value - a.value);
  const spendable = sorted.reduce((sum, utxo) => sum + utxo.value, 0);
  const selected: WalletUtxo[] = [];
  let sum = 0;
  let fee = 0;
  let changeValue = 0;
  let satisfied = false;
  for (const utxo of sorted) {
    selected.push(utxo);
    sum += utxo.value;
    // Affordable at all once the sum covers the amount plus the fee of
    // the smallest (no-change) form of this transaction.
    if (sum < amount + feeFor(feeRate, selected.length, 1)) continue;
    const feeWithChange = feeFor(feeRate, selected.length, 2);
    const change = sum - amount - feeWithChange;
    if (change >= network.dustLimit) {
      fee = feeWithChange;
      changeValue = change;
    } else {
      // Change would be dust (or paying for a change output at all is
      // not worthwhile): fold the remainder into the fee (locked rule).
      fee = sum - amount;
      changeValue = 0;
    }
    satisfied = true;
    break;
  }
  if (!satisfied) {
    throw new TxError(
      `Insufficient funds: this send needs more than the spendable ${spendable} nusan (confirmed UTXOs only).`,
      "insufficient",
    );
  }

  // bitcoinjs-lib v7 carries values as bigint across the Psbt API;
  // the wallet's own arithmetic stays in integer numbers and converts
  // at this boundary.
  const psbt = new bitcoin.Psbt({ network: btcNetwork });
  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(utxo.address, btcNetwork),
        value: BigInt(utxo.value),
      },
      // Without an explicit sequence, bitcoinjs-lib uses 0xffffffff
      // (final, no RBF). Only set the field when signalling.
      ...(rbf ? { sequence: RBF_SEQUENCE } : {}),
    });
  }
  psbt.addOutput({ address: args.to, value: BigInt(amount) });
  if (changeValue > 0) {
    psbt.addOutput({ address: args.changeAddress, value: BigInt(changeValue) });
  }

  return {
    psbtBase64: psbt.toBase64(),
    summary: {
      to: args.to,
      amount,
      fee,
      feeRate,
      total: amount + fee,
      inputs: selected.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        address: utxo.address,
      })),
      changeAddress: changeValue > 0 ? args.changeAddress : null,
      changeValue,
      rbf: rbf === true,
    },
  };
}

// ---------------------------------------------------------------------------
// PSBT inspection and signing

export interface PsbtInputInfo {
  address: string | null;
  value: number;
}

export interface PsbtOutputInfo {
  address: string | null;
  value: number;
}

export interface PsbtSummary {
  inputs: PsbtInputInfo[];
  outputs: PsbtOutputInfo[];
  totalIn: number;
  totalOut: number;
  fee: number;
  /** Fee rate implied by the PSBT, recalculated against its size. */
  feeRate: number;
}

function scriptAddress(script: Uint8Array, network: bitcoin.Network): string | null {
  try {
    return bitcoin.address.fromOutputScript(script, network);
  } catch {
    return null;
  }
}

/**
 * Parse a base64 PSBT and summarize what it does: where its inputs come
 * from, where its outputs go, and the fee it implies. The fee rate is
 * recalculated here from the transaction's estimated final size (the
 * unsigned size plus a P2WPKH witness estimate per input); it is never
 * taken from whoever supplied the PSBT.
 */
export function summarizePsbt(
  psbtBase64: string,
  network: NuxNetwork,
): { psbt: bitcoin.Psbt; summary: PsbtSummary } {
  const btcNetwork = toBitcoinJsNetwork(network);
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: btcNetwork });
  } catch {
    throw new TxError("The supplied data is not a valid PSBT.", "invalid");
  }

  // The BIP174 unsigned transaction is stored in a library-internal
  // shape; parsing its serialization with the regular Transaction
  // reader gives the input order (for previous-output lookups) and the
  // unsigned size.
  const unsignedTx = bitcoin.Transaction.fromBuffer(
    Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer()),
  );

  const inputs: PsbtInputInfo[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    const data = psbt.data.inputs[i];
    if (!data) {
      throw new TxError("The PSBT is missing input data.", "invalid");
    }
    let value: number | null = null;
    let address: string | null = null;
    if (data.witnessUtxo) {
      value = Number(data.witnessUtxo.value);
      address = scriptAddress(data.witnessUtxo.script, btcNetwork);
    } else if (data.nonWitnessUtxo) {
      const prevTx = bitcoin.Transaction.fromBuffer(
        Buffer.from(data.nonWitnessUtxo),
      );
      const prevOut = prevTx.outs[unsignedTx.ins[i]?.index ?? -1];
      if (prevOut) {
        value = Number(prevOut.value);
        address = scriptAddress(prevOut.script, btcNetwork);
      }
    }
    if (value === null) {
      throw new TxError(
        "A PSBT input does not carry its previous output data, so its value cannot be verified.",
        "invalid",
      );
    }
    inputs.push({ address, value });
  }

  const outputs: PsbtOutputInfo[] = psbt.txOutputs.map((output) => ({
    address: output.address ?? null,
    value: Number(output.value),
  }));

  const totalIn = inputs.reduce((sum, input) => sum + input.value, 0);
  const totalOut = outputs.reduce((sum, output) => sum + output.value, 0);
  const fee = totalIn - totalOut;
  if (fee < 0) {
    throw new TxError("The PSBT spends more than its inputs provide.", "invalid");
  }
  const estimatedVsize = unsignedTx.virtualSize() + psbt.inputCount * 68;
  return {
    psbt,
    summary: {
      inputs,
      outputs,
      totalIn,
      totalOut,
      fee,
      feeRate: Math.ceil(fee / estimatedVsize),
    },
  };
}

/**
 * Sign every input of a PSBT with the wallet's keys. Ownership is
 * enforced here as the last line of defense: an input whose address is
 * not in the wallet's ownership map aborts the signing.
 */
export function signWalletPsbt(
  psbt: bitcoin.Psbt,
  mnemonic: string,
  network: NuxNetwork,
  owned: Map<string, { chain: 0 | 1; index: number }>,
): void {
  const btcNetwork = toBitcoinJsNetwork(network);
  for (let i = 0; i < psbt.inputCount; i++) {
    const data = psbt.data.inputs[i];
    const script = data?.witnessUtxo?.script;
    const address = script ? scriptAddress(script, btcNetwork) : null;
    const position = address ? owned.get(address) : undefined;
    if (!position) {
      throw new TxError(
        "The PSBT spends an input that does not belong to this wallet.",
        "invalid",
      );
    }
    const key = derivePrivateKey(mnemonic, network, position.chain, position.index);
    psbt.signInput(i, toSigner(key));
  }
}

/** Finalize all inputs and return the raw transaction hex. */
export function finalizeToHex(psbt: bitcoin.Psbt): string {
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}

// ---------------------------------------------------------------------------
// Legacy message signing (Nusacoin Core), exactly:
//   hash   = SHA256d( varint(len(magic)) || magic ||
//                     varint(len(message)) || message )
//   magic  = "Nusacoin Signed Message:\n" (the network's messagePrefix)
//   output = base64( header || r || s ), header = 31 + recovery id for
//   this wallet's compressed keys — the compact recoverable form Core's
//   SignCompact produces and `verifymessage` accepts.

function encodeVarint(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = 0xfd;
    out.writeUInt16LE(value, 1);
    return out;
  }
  if (value <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = 0xfe;
    out.writeUInt32LE(value, 1);
    return out;
  }
  throw new TxError("Message is too long to sign.");
}

export function messageSigningHash(message: string, network: NuxNetwork): Buffer {
  const btcNetwork = toBitcoinJsNetwork(network);
  const prefix = Buffer.from(btcNetwork.messagePrefix, "utf8");
  const payload = Buffer.from(message, "utf8");
  const framed = Buffer.concat([
    encodeVarint(prefix.length),
    prefix,
    encodeVarint(payload.length),
    payload,
  ]);
  return Buffer.from(bitcoin.crypto.hash256(framed));
}

export function signMessageLegacy(
  message: string,
  key: DerivedKey,
  network: NuxNetwork,
): string {
  const hash = messageSigningHash(message, network);
  const { signature, recoveryId } = ecc.signRecoverable(hash, key.privateKey);
  const header = 31 + recoveryId;
  return Buffer.concat([Buffer.from([header]), Buffer.from(signature)]).toString(
    "base64",
  );
}

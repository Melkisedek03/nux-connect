// Minimal client for the Esplora-style REST API served by the Nusacoin
// electrs instances. All calls go to the base URL of one specific
// network; fee data in particular must always come from the active
// network's own instance, never from another network's endpoint.

import type { NuxNetwork } from "./networks";

export interface AddressStats {
  fundedTxoCount: number;
  fundedTxoSum: number;
  spentTxoCount: number;
  spentTxoSum: number;
  txCount: number;
}

export interface AddressInfo {
  address: string;
  /** Confirmed side (>= 1 confirmation), from `chain_stats`. */
  chainStats: AddressStats;
  /** Unconfirmed side (mempool), from `mempool_stats`. */
  mempoolStats: AddressStats;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    blockHeight?: number;
    blockHash?: string;
    blockTime?: number;
  };
}

interface RawStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

function mapStats(raw: RawStats): AddressStats {
  return {
    fundedTxoCount: raw.funded_txo_count,
    fundedTxoSum: raw.funded_txo_sum,
    spentTxoCount: raw.spent_txo_count,
    spentTxoSum: raw.spent_txo_sum,
    txCount: raw.tx_count,
  };
}

/** Fallback fee rate (nusan/vbyte) used when the endpoint is unreachable. */
export const FALLBACK_FEE_RATE = 1;

/**
 * Backoff schedule for transient electrs failures, in milliseconds,
 * jittered ±25%. The public instances sit behind a shared rate
 * limiter whose pressure shows up in two forms (both seen in field
 * testing): HTTP 429 responses, and — when the limiter escalates —
 * dropped connections, which surface as network-level fetch failures.
 * A wallet discovery scan is dozens of requests, so reads ride out
 * both forms on this schedule. The broadcast POST retries 429 only: a
 * 429 means the request was rejected before processing, but after a
 * network failure the transaction may already be accepted, and a
 * blind retry would report a duplicate as a failure.
 */
const RATE_LIMIT_DELAYS_MS = [600, 1500, 3000, 6000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: { method?: string; body?: string } | undefined,
  retryNetworkFailure: boolean,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const baseDelay = RATE_LIMIT_DELAYS_MS[attempt];
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 || baseDelay === undefined) {
        return response;
      }
    } catch (error) {
      if (!retryNetworkFailure || baseDelay === undefined) {
        throw error;
      }
    }
    await sleep(baseDelay * (0.75 + Math.random() * 0.5));
  }
}

export class ElectrsClient {
  constructor(private readonly network: NuxNetwork) {}

  private async getText(path: string): Promise<string> {
    const response = await fetchWithRetry(
      `${this.network.electrsBaseUrl}${path}`,
      undefined,
      true,
    );
    if (!response.ok) {
      throw new Error(`electrs ${path} failed with HTTP ${response.status}`);
    }
    return response.text();
  }

  private async getJson<T>(path: string): Promise<T> {
    const text = await this.getText(path);
    return JSON.parse(text) as T;
  }

  async getTipHeight(): Promise<number> {
    const text = await this.getText("/blocks/tip/height");
    return Number.parseInt(text.trim(), 10);
  }

  /** Map of confirmation target (blocks) to fee rate in nusan/vbyte. */
  async getFeeEstimates(): Promise<Record<string, number>> {
    return this.getJson<Record<string, number>>("/fee-estimates");
  }

  /**
   * Fee rate for the nearest confirmation target. Falls back to
   * FALLBACK_FEE_RATE when the endpoint cannot be reached; the fallback
   * is this network's own default, never another network's data.
   */
  async getFeeRate(): Promise<number> {
    try {
      const estimates = await this.getFeeEstimates();
      const rate = estimates["1"] ?? estimates["3"] ?? FALLBACK_FEE_RATE;
      return typeof rate === "number" && rate > 0 ? rate : FALLBACK_FEE_RATE;
    } catch {
      return FALLBACK_FEE_RATE;
    }
  }

  async getAddressInfo(address: string): Promise<AddressInfo> {
    const raw = await this.getJson<{
      address: string;
      chain_stats: RawStats;
      mempool_stats: RawStats;
    }>(`/address/${address}`);
    return {
      address: raw.address,
      chainStats: mapStats(raw.chain_stats),
      mempoolStats: mapStats(raw.mempool_stats),
    };
  }

  /**
   * Confirmed balance in nusan: funded minus spent on the confirmed
   * side. By the locked definition, "confirmed" means >= 1 confirmation.
   */
  async getConfirmedBalance(address: string): Promise<number> {
    const info = await this.getAddressInfo(address);
    return info.chainStats.fundedTxoSum - info.chainStats.spentTxoSum;
  }

  /** Unconfirmed balance delta in nusan (mempool side). */
  async getUnconfirmedBalance(address: string): Promise<number> {
    const info = await this.getAddressInfo(address);
    return info.mempoolStats.fundedTxoSum - info.mempoolStats.spentTxoSum;
  }

  async getAddressUtxos(address: string): Promise<Utxo[]> {
    const raw = await this.getJson<
      {
        txid: string;
        vout: number;
        value: number;
        status: {
          confirmed: boolean;
          block_height?: number;
          block_hash?: string;
          block_time?: number;
        };
      }[]
    >(`/address/${address}/utxo`);
    return raw.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      status: {
        confirmed: u.status.confirmed,
        blockHeight: u.status.block_height,
        blockHash: u.status.block_hash,
        blockTime: u.status.block_time,
      },
    }));
  }

  /** Broadcast a signed raw transaction (hex). Returns the txid. */
  async broadcastTx(rawTxHex: string): Promise<string> {
    const response = await fetchWithRetry(
      `${this.network.electrsBaseUrl}/tx`,
      {
        method: "POST",
        body: rawTxHex,
      },
      false,
    );
    if (!response.ok) {
      throw new Error(`electrs broadcast failed with HTTP ${response.status}`);
    }
    return (await response.text()).trim();
  }
}

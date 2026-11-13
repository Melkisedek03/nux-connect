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

/** A transaction's inputs; only prevout addresses are used. */
export interface TxDetail {
  vin: {
    prevout?: {
      scriptpubkey_address?: string;
    };
  }[];
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
 *
 * A 429 carrying a Retry-After header is honored instead of this
 * schedule: the header names the wait the limiter asks for, capped
 * at MAX_RETRY_AFTER_MS.
 */
const RATE_LIMIT_DELAYS_MS = [600, 1500, 3000, 6000];

/** Longest wait honored from a Retry-After header, in milliseconds. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Thrown when the endpoint keeps answering HTTP 429 after the
 * retries are spent. Carries the wait the server last asked for (if
 * any), so callers can tell a rate limit apart from other failures
 * and say when to try again.
 */
export class RateLimitError extends Error {
  /** Milliseconds to wait before retrying, when the server said so. */
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null) {
    super("electrs rate limited (HTTP 429)");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a Retry-After header value: whole seconds, or an HTTP-date
 * (the wait is the delta from now). Returns the wait in milliseconds,
 * capped at MAX_RETRY_AFTER_MS, or null when the value is absent or
 * unparsable.
 */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * Friendly Indonesian status line for a rate-limit failure, carrying
 * the wait the server asked for when known. The background formats
 * the status error with this; the popup shows it as-is.
 */
export function formatRateLimitMessage(retryAfterMs: number | null): string {
  if (retryAfterMs === null) {
    return "Server membatasi permintaan sementara — coba lagi sebentar lagi.";
  }
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `Server membatasi permintaan sementara — coba lagi dalam ~${seconds} detik.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: { method?: string; body?: string } | undefined,
  retryNetworkFailure: boolean,
): Promise<Response> {
  let retryAfterMs: number | null = null;
  for (let attempt = 0; ; attempt++) {
    const baseDelay = RATE_LIMIT_DELAYS_MS[attempt];
    try {
      const response = await fetch(url, init);
      if (response.status !== 429) {
        return response;
      }
      // A 429 means rejected before processing, so waiting the
      // server's stated window and retrying is safe. The header is
      // honored exactly (no jitter: waiting less would re-trip the
      // limiter); without it the scheduled backoff applies. Once the
      // retries are spent the caller gets a RateLimitError carrying
      // the last stated wait, not a bare 429 response.
      retryAfterMs = parseRetryAfter(
        response.headers?.get("Retry-After") ?? null,
      );
      if (baseDelay === undefined) {
        throw new RateLimitError(retryAfterMs);
      }
      await sleep(retryAfterMs ?? baseDelay * (0.75 + Math.random() * 0.5));
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }
      if (!retryNetworkFailure || baseDelay === undefined) {
        throw error;
      }
      await sleep(baseDelay * (0.75 + Math.random() * 0.5));
    }
  }
}

export class ElectrsClient {
  constructor(private readonly network: NuxNetwork) {}

  /** The network this client talks to. Callers that build from a
   * client (drafts, cache syncs) take their network from here, so a
   * network switch mid-operation cannot mix one network's UTXOs
   * into another network's transaction. */
  getNetwork(): NuxNetwork {
    return this.network;
  }

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
   * Fee rate for the nearest confirmation target, as an integer
   * nusan/vbyte: electrs answers floats (1.71...), but fee rates are
   * integer throughout the spec (the guard is 1-546), so the raw
   * estimate is rounded here, once, for every consumer. Falls back to
   * FALLBACK_FEE_RATE when the endpoint cannot be reached; the fallback
   * is this network's own default, never another network's data.
   */
  async getFeeRate(): Promise<number> {
    try {
      const estimates = await this.getFeeEstimates();
      const rate = estimates["1"] ?? estimates["3"] ?? FALLBACK_FEE_RATE;
      return typeof rate === "number" && rate > 0
        ? Math.max(1, Math.round(rate))
        : FALLBACK_FEE_RATE;
    } catch {
      return FALLBACK_FEE_RATE;
    }
  }

  /**
   * Whether a UTXO is already spent, via the outspend endpoint. The
   * public instances answer {"spent": false} even for unknown
   * outpoints, so there is no 404 case; transport and parse failures
   * throw, and the caller decides whether to proceed without
   * verification.
   */
  async isUtxoSpent(txid: string, vout: number): Promise<boolean> {
    const data = await this.getJson<{ spent?: unknown }>(
      `/tx/${txid}/outspend/${vout}`,
    );
    if (typeof data?.spent !== "boolean") {
      throw new Error("electrs outspend returned an unrecognized shape");
    }
    return data.spent;
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

  /** Fetch one transaction's inputs (only prevout addresses are used). */
  async getTx(txid: string): Promise<TxDetail> {
    const raw = await this.getJson<{
      vin: { prevout?: { scriptpubkey_address?: string } }[];
    }>(`/tx/${txid}`);
    return { vin: raw.vin ?? [] };
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

// Read-only NUX market price (Milestone 8).
//
// Same recipe as the ELNUX Jelajah tab: the NUX/USDT last daily close
// from qutrade.io's public TradingView UDF datafeed, converted to
// rupiah with the USDT/IDR rate from Indodax's public ticker.
// qutrade has no IDR pair and Indodax lists no NUX pair, so the two
// sources combine; both are public, no auth, no API key.
//
// The price is the MAINNET market price. On testnet it is
// informational (testnet coins have no market value) — the popup
// labels it as a market price, never as a valuation of testnet coins.
//
// The thin NUX market makes the websocket useless for one-shot
// prices (last_price only broadcasts on a trade, and NUX can go a
// whole day without one), so this module polls the daily-candle REST
// endpoint instead. The last candle is the current day's still
// forming candle, so the last close tracks the market within the day.

export interface MarketInfo {
  /** Last NUX/USDT daily close, in USDT. */
  lastUsdt: number;
  /** Previous daily close, or null when unavailable. */
  prevCloseUsdt: number | null;
  /** USDT/IDR rate, or null when unavailable. */
  usdtIdrRate: number | null;
  /** NUX price in IDR, or null when the rate is unavailable. */
  priceIdr: number | null;
  /** Change between the last two daily closes, in percent. */
  changePct: number | null;
  /** Unix milliseconds when the data was fetched. */
  fetchedAt: number;
}

const QUTRADE_UDF_BASE = "https://qutrade.io/api/spot/tradingview";
const USDT_IDR_TICKER_URL = "https://indodax.com/api/ticker/usdtidr";
const FETCH_TIMEOUT_MS = 12_000;
const CANDLE_DAYS = 10;

/**
 * Parse the close series from a decoded UDF /history response.
 * A "no_data"/"error" status or an unrecognized shape yields [].
 */
export function parseUdfCloses(json: unknown): number[] {
  if (typeof json !== "object" || json === null) return [];
  const data = json as Record<string, unknown>;
  if (data["s"] !== "ok") return [];
  const t = data["t"];
  const c = data["c"];
  if (!Array.isArray(t) || !Array.isArray(c)) return [];
  const closes: number[] = [];
  const n = Math.min(t.length, c.length);
  for (let i = 0; i < n; i++) {
    const value = c[i];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      closes.push(value);
    }
  }
  return closes;
}

/**
 * Parse the last USDT/IDR rate from the Indodax ticker
 * ({"ticker": {"last": "18207", ...}}). Null on an unrecognized
 * shape or a non-positive value.
 */
export function parseUsdtIdrRate(json: unknown): number | null {
  if (typeof json !== "object" || json === null) return null;
  const ticker = (json as Record<string, unknown>)["ticker"];
  if (typeof ticker !== "object" || ticker === null) return null;
  const last = (ticker as Record<string, unknown>)["last"];
  const value =
    typeof last === "number" ? last : Number.parseFloat(String(last));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCloses(): Promise<number[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - CANDLE_DAYS * 24 * 60 * 60;
  // countback is required: without it the server answers "exit".
  // The resolution token is "1D", not "D" (same "exit" otherwise).
  const url =
    `${QUTRADE_UDF_BASE}/history?symbol=NUX_USDT&resolution=1D` +
    `&from=${from}&to=${now}&countback=3`;
  return parseUdfCloses(await fetchJson(url));
}

async function fetchUsdtIdrRate(): Promise<number | null> {
  return parseUsdtIdrRate(await fetchJson(USDT_IDR_TICKER_URL));
}

/**
 * Fetch fresh market info. Returns null when no price is available;
 * never throws. The two sources are independent: a missing USDT/IDR
 * rate still yields the USDT price, with priceIdr null.
 */
export async function fetchMarketInfo(): Promise<MarketInfo | null> {
  const [closes, rate] = await Promise.all([
    fetchCloses(),
    fetchUsdtIdrRate(),
  ]);
  if (closes.length === 0) return null;
  const lastUsdt = closes[closes.length - 1];
  if (lastUsdt === undefined) return null;
  const prevRaw = closes.length >= 2 ? closes[closes.length - 2] : undefined;
  const prevCloseUsdt = prevRaw ?? null;
  const changePct =
    prevCloseUsdt !== null && prevCloseUsdt > 0
      ? ((lastUsdt - prevCloseUsdt) / prevCloseUsdt) * 100
      : null;
  return {
    lastUsdt,
    prevCloseUsdt,
    usdtIdrRate: rate,
    priceIdr: rate !== null ? lastUsdt * rate : null,
    changePct,
    fetchedAt: Date.now(),
  };
}

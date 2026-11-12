// Display-unit handling for amounts: nusan (integer, the chain
// unit) or NUX (decimal, 1 NUX = 100,000,000 nusan). A pure display
// concern: the background, the provider, and the transaction engine
// always work in integer nusan. Only the popup and the approval
// window convert for display, and the popup's send form converts a
// NUX decimal back to integer nusan before drafting — the amount
// that reaches the approval window is always whole nusan.
//
// The choice is a user preference in chrome.storage.local, owned by
// the background like every other setting; the popup and the
// approval window read it through internal messages.

export const NUSAN_PER_NUX = 100_000_000;
export const DISPLAY_UNIT_KEY = "displayUnit";

export type DisplayUnit = "nusan" | "nux";

/** Anything that is not exactly "nux" reads as the default nusan,
 * so a missing or corrupted stored value never breaks the UI. */
export function parseDisplayUnit(value: unknown): DisplayUnit {
  return value === "nux" ? "nux" : "nusan";
}

export async function readDisplayUnit(): Promise<DisplayUnit> {
  const stored = await chrome.storage.local.get([DISPLAY_UNIT_KEY]);
  return parseDisplayUnit(stored[DISPLAY_UNIT_KEY]);
}

export async function writeDisplayUnit(unit: DisplayUnit): Promise<void> {
  await chrome.storage.local.set({ [DISPLAY_UNIT_KEY]: unit });
}

/** Format an integer nusan amount in the chosen unit, without the
 * unit label: "318,210" or "0.0031821". Integer arithmetic only —
 * no float division, so long values stay exact; a negative amount
 * (an unconfirmed balance after a send) keeps its sign. */
export function formatAmountValue(nusan: number, unit: DisplayUnit): string {
  if (unit === "nusan") return nusan.toLocaleString("en-US");
  const sign = nusan < 0 ? "-" : "";
  const abs = Math.abs(nusan);
  const whole = Math.floor(abs / NUSAN_PER_NUX);
  const frac = abs % NUSAN_PER_NUX;
  const fracText = String(frac).padStart(8, "0").replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return fracText === "" ? `${sign}${wholeText}` : `${sign}${wholeText}.${fracText}`;
}

/** The same, with the unit label: "318,210 nusan" / "0.0031821 NUX". */
export function formatAmount(nusan: number, unit: DisplayUnit): string {
  return `${formatAmountValue(nusan, unit)} ${unit === "nusan" ? "nusan" : "NUX"}`;
}

/** Parse a NUX decimal string into integer nusan, or null when the
 * text is not a valid NUX amount: empty, negative, non-numeric, or
 * more than 8 decimal places — a fraction below 1 nusan does not
 * exist. Thousands separators are accepted and stripped, since the
 * send form adds them while typing. */
export function nuxStringToNusan(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const [wholeText = "", fracText = ""] = cleaned.split(".");
  if (fracText.length > 8) return null;
  const whole = Number(wholeText === "" ? "0" : wholeText);
  const frac = Number(fracText.padEnd(8, "0"));
  const nusan = whole * NUSAN_PER_NUX + frac;
  return Number.isSafeInteger(nusan) ? nusan : null;
}

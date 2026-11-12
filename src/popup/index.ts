// Toolbar popup: wallet setup, unlock, and status.
//
// The popup never touches secrets beyond forwarding the password (and,
// at import, the pasted phrase) to the background worker over the
// extension's internal message channel, and showing the freshly
// generated recovery phrase exactly once after creation. All vault
// logic lives in the background (src/lib/vault.ts).

import "../lib/globals";
import { encodeQrMatrix } from "../lib/qrcode";
import {
  formatAmount,
  formatAmountValue,
  nuxStringToNusan,
  parseDisplayUnit,
  type DisplayUnit,
} from "../lib/units";

interface StatusResult {
  network: string;
  networkLabel: string;
  tipHeight: number | null;
  feeRate: number | null;
  statusError?: string;
  hasVault: boolean;
  unlocked: boolean;
  address: string | null;
  confirmedBalance: number | null;
  unconfirmedBalance: number | null;
}

interface Connection {
  origin: string;
  addresses: string[];
}

interface ActivityEntry {
  key: string;
  txid: string;
  vout: number;
  address: string;
  amount: number;
  status: "pending" | "confirmed" | "internal";
  firstSeenAt: number;
  confirmedAt?: number;
}

type InternalRequest =
  | "getStatus"
  | "vaultCreate"
  | "vaultImport"
  | "vaultUnlock"
  | "vaultLock"
  | "getConnections"
  | "getActivity"
  | "setNotificationsEnabled"
  | "notificationsOpened"
  | "popupSendDraft"
  | "popupSendConfirm"
  | "popupSendCancel"
  | "getPendingWalletSend"
  | "getMaxSendable"
  | "getLastSend"
  | "addressBookList"
  | "addressBookAdd"
  | "addressBookRemove"
  | "getMarketInfo"
  | "getReceiveAddress"
  | "refreshReceiveAddress"
  | "getDisplayUnit"
  | "setDisplayUnit"
  | "getNetwork"
  | "setNetwork"
  | "disconnectOrigin";

interface MarketInfo {
  lastUsdt: number;
  prevCloseUsdt: number | null;
  usdtIdrRate: number | null;
  priceIdr: number | null;
  changePct: number | null;
  fetchedAt: number;
}

interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
  network: string;
  createdAt: number;
}

interface LastSend {
  to: string;
  amount: number;
  fee: number;
  rbf: boolean;
  ok: boolean;
  txid: string | null;
  error: string | null;
  at: number;
}

/** The draft summary the background returns for a popup send: the
 * same shape the approval window renders. */
interface SendSummary {
  to: string;
  amount: number;
  fee: number;
  feeRate: number;
  total: number;
  changeAddress: string | null;
  changeValue: number;
  rbf: boolean;
}

interface PendingWalletSend {
  id: string;
  summary: SendSummary;
}

/** The current receive address (see src/lib/receiveaddress.ts):
 * the address the home row and the receive view show. The dApp-facing
 * account stays the primary address; only the displayed receive
 * address moves when the user asks for a fresh one. */
interface ReceiveAddressResult {
  address: string;
  index: number;
  canRefresh: boolean;
}

function call<T>(request: InternalRequest, payload: object = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { kind: "nux-internal", request, ...payload },
      (response: { ok: boolean; result?: T; error?: { message: string } }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.result as T);
        } else {
          reject(new Error(response?.error?.message ?? "Internal error."));
        }
      },
    );
  });
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const VIEWS = [
  "viewLoading",
  "viewSetup",
  "viewMnemonic",
  "viewUnlock",
  "viewWallet",
  "viewSend",
  "viewReview",
  "viewReceive",
  "viewNetworkConfirm",
] as const;

function show(view: (typeof VIEWS)[number]): void {
  for (const id of VIEWS) {
    el(id).hidden = id !== view;
  }
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

let setupMode: "create" | "import" = "create";

/** The user's display unit for amounts, loaded from the background
 * before the first render (default nusan). Every amount this popup
 * shows — balances, activity, last send — formats through it. */
let displayUnit: DisplayUnit = "nusan";

/** The last-known confirmed balance, for the review's remaining
 * figure. Updated on every successful status read; null until the
 * first one lands. */
let lastConfirmedBalance: number | null = null;

/** The active network id, from the last status read (testnet until
 * the first one lands). The review's network row and the badge
 * switch read it; it only changes through a status read, so it
 * always matches what the popup shows. */
let currentNetwork = "testnet";

/** Paint the header badge for a network: the label plus the
 * per-network color — red for testnet, yellow for mainnet. */
function applyNetworkBadge(network: string): void {
  currentNetwork = network;
  const badge = el("networkBadge");
  badge.textContent = network === "testnet" ? "TESTNET" : network.toUpperCase();
  badge.className = `badge ${network === "testnet" ? "testnet" : "mainnet"}`;
}

/** Apply the current unit to the static labels: the toggle button,
 * the hero unit, the send form's label, and the send field's
 * keyboard. The send amount itself is cleared — a value typed under
 * the other unit would parse as a wildly different amount. */
function applyDisplayUnit(): void {
  setText("unitToggle", `Satuan: ${displayUnit === "nusan" ? "nusan" : "NUX"}`);
  setText("totalUnit", displayUnit === "nusan" ? "nusan" : "NUX");
  setText(
    "sendAmountLabel",
    displayUnit === "nusan" ? "Jumlah (nusan)" : "Jumlah (NUX)",
  );
  el<HTMLInputElement>("sendAmount").inputMode =
    displayUnit === "nusan" ? "numeric" : "decimal";
  el<HTMLInputElement>("sendAmount").value = "";
  setText("sendError", "");
}

async function handleUnitToggle(): Promise<void> {
  const next: DisplayUnit = displayUnit === "nusan" ? "nux" : "nusan";
  try {
    const result = await call<{ unit: DisplayUnit }>("setDisplayUnit", {
      unit: next,
    });
    // Never trust the echoed value blindly: a missing or corrupted
    // unit reads as the nusan default.
    displayUnit = parseDisplayUnit(result.unit);
    applyDisplayUnit();
    // Re-render every amount from the fresh status.
    await refresh();
  } catch {
    // The preference did not save; the display keeps the old unit.
  }
}

/** Whether the one-time mainnet acknowledgment is already stored
 * (loaded once at startup; set locally after the user confirms).
 * The background enforces the acknowledgment too — this flag only
 * decides whether the card needs to show at all. */
let mainnetAcknowledged = false;

/** The view the user was on before the network-confirm card, so
 * Batal returns there instead of always landing home. */
let viewBeforeNetworkConfirm: (typeof VIEWS)[number] | null = null;

/** True while a network switch is in flight. A switch is slow on a
 * cold cache — the first switch to a network waits for a full
 * discovery scan — so the flag keeps a second click (badge or
 * confirm) from starting a duplicate switch, and the buttons stay
 * disabled until it lands. */
let switchingNetwork = false;

/** Switch to the other network. The background rejects the wallet's
 * pending review (it belongs to the old network), so the local
 * review state is cleared too; the form keeps its values — a
 * recipient address for the other network fails the draft's
 * validation with a clear error, and the review names its network.
 * Returns false when a switch is already in flight and this call
 * was skipped, true when the switch ran. */
async function switchNetwork(
  target: string,
  acknowledge: boolean,
): Promise<boolean> {
  if (switchingNetwork) return false;
  switchingNetwork = true;
  const badge = el<HTMLButtonElement>("networkBadge");
  const ok = el<HTMLButtonElement>("networkConfirmOk");
  const cancel = el<HTMLButtonElement>("networkConfirmCancel");
  badge.disabled = true;
  ok.disabled = true;
  // Cancel stays disabled too: it only hides the card, it cannot
  // stop a switch already in flight, so leaving it enabled would
  // promise a cancellation that never happens.
  cancel.disabled = true;
  setText(
    "networkConfirmStatus",
    target === "mainnet"
      ? "Memindai dompet Mainnet…"
      : "Memindai dompet Testnet…",
  );
  try {
    const result = await call<{ network: string }>("setNetwork", {
      network: target,
      acknowledge,
    });
    reviewPendingId = null;
    applyNetworkBadge(result.network);
    await refresh();
    return true;
  } finally {
    switchingNetwork = false;
    badge.disabled = false;
    ok.disabled = false;
    cancel.disabled = false;
    setText("networkConfirmStatus", "");
  }
}

async function handleNetworkBadgeClick(): Promise<void> {
  const target = currentNetwork === "testnet" ? "mainnet" : "testnet";
  if (target === "mainnet" && !mainnetAcknowledged) {
    // First mainnet switch needs the one-time acknowledgment; the
    // card below collects it. Later switches go straight through.
    viewBeforeNetworkConfirm = currentView();
    setText("networkConfirmError", "");
    show("viewNetworkConfirm");
    return;
  }
  try {
    await switchNetwork(target, false);
  } catch {
    // The switch failed; the badge still shows the old network.
  }
}

async function handleNetworkConfirm(): Promise<void> {
  setText("networkConfirmError", "");
  try {
    // Only a switch that actually ran acknowledges mainnet; a
    // skipped duplicate leaves the flag to the in-flight switch.
    if (await switchNetwork("mainnet", true)) {
      mainnetAcknowledged = true;
    }
  } catch (error) {
    setText(
      "networkConfirmError",
      error instanceof Error ? error.message : "Tidak bisa pindah jaringan.",
    );
  }
}

function handleNetworkConfirmCancel(): void {
  show(viewBeforeNetworkConfirm ?? "viewWallet");
  viewBeforeNetworkConfirm = null;
}

function setSetupMode(mode: "create" | "import"): void {
  setupMode = mode;
  el("paneCreate").hidden = mode !== "create";
  el("paneImport").hidden = mode !== "import";
  el("tabCreate").className = mode === "create" ? "" : "secondary";
  el("tabImport").className = mode === "import" ? "" : "secondary";
  setText("setupError", "");
}

function renderWallet(status: StatusResult): void {
  applyNetworkBadge(status.network);
  setText("networkName", `${status.networkLabel} (${status.network})`);
  // A failed refresh returns null figures: keep the last-known values
  // instead of blanking them to dashes. The initial "—" in the markup
  // survives untouched until the first successful read, and the note
  // below still says the backend failed. The hero total only moves
  // when both halves are known — a half-known total would be wrong.
  if (status.confirmedBalance !== null) {
    lastConfirmedBalance = status.confirmedBalance;
    setText(
      "confirmedBalance",
      formatAmountValue(status.confirmedBalance, displayUnit),
    );
  }
  if (status.unconfirmedBalance !== null) {
    setText(
      "unconfirmedBalance",
      formatAmountValue(status.unconfirmedBalance, displayUnit),
    );
  }
  if (status.confirmedBalance !== null && status.unconfirmedBalance !== null) {
    setText(
      "totalBalance",
      formatAmountValue(
        status.confirmedBalance + status.unconfirmedBalance,
        displayUnit,
      ),
    );
  }
  if (status.tipHeight !== null) {
    setText("tipHeight", String(status.tipHeight));
  }
  if (status.feeRate !== null) {
    setText("feeRate", String(status.feeRate));
  }
  if (status.statusError) {
    setText("walletNote", `Status backend: ${status.statusError}`);
  } else {
    setText("walletNote", walletNoteDefault);
  }
  show("viewWallet");
  void renderConnections();
  void renderActivity();
  void renderLastSend();
  void renderAddressBook();
  void renderMarket(status);
  void renderReceiveAddress();
}

/** Draw the current receive address (home row + receive view + QR).
 * The background resolves the address from the persisted pointer;
 * this popup only displays it. */
async function renderReceiveAddress(): Promise<void> {
  try {
    const result = await call<ReceiveAddressResult>("getReceiveAddress");
    applyReceiveAddress(result);
  } catch {
    // The wallet view stays usable without the receive address.
  }
}

function applyReceiveAddress(result: ReceiveAddressResult): void {
  setText("walletAddress", result.address);
  setText("receiveAddress", result.address);
  el<HTMLButtonElement>("receiveRefresh").disabled = !result.canRefresh;
  renderQr(el<HTMLCanvasElement>("receiveQr"), result.address);
}

/** Render a QR code of `text` onto a canvas: dark modules on white,
 * with a 4-module quiet zone around the symbol. */
function renderQr(canvas: HTMLCanvasElement, text: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const matrix = encodeQrMatrix(text);
  const size = canvas.width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  if (!matrix) return;
  const modules = matrix.length;
  const quiet = 4;
  const scale = Math.floor(size / (modules + quiet * 2));
  const offset = Math.floor((size - scale * modules) / 2);
  ctx.fillStyle = "#062b12";
  for (let y = 0; y < modules; y++) {
    const row = matrix[y];
    if (!row) continue;
    for (let x = 0; x < modules; x++) {
      if (row[x]) {
        ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
      }
    }
  }
}

/** Copy `text` to the clipboard, with a legacy fallback for contexts
 * where the async clipboard API is unavailable. The button briefly
 * shows "Disalin!" as feedback. */
async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    button.textContent = "Disalin!";
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch {
    // Copying failed silently; the address is still visible to select.
  }
}

async function handleReceiveRefresh(): Promise<void> {
  const button = el<HTMLButtonElement>("receiveRefresh");
  setText("receiveError", "");
  button.disabled = true;
  try {
    const result = await call<ReceiveAddressResult>("refreshReceiveAddress");
    applyReceiveAddress(result);
  } catch (error) {
    setText(
      "receiveError",
      error instanceof Error ? error.message : "Tidak bisa memuat alamat baru.",
    );
  } finally {
    // The disabled state follows canRefresh, not the request lifecycle:
    // re-enable only when a further unused address exists.
    try {
      const result = await call<ReceiveAddressResult>("getReceiveAddress");
      el<HTMLButtonElement>("receiveRefresh").disabled = !result.canRefresh;
    } catch {
      button.disabled = false;
    }
  }
}

function renderConnectionsList(connections: Connection[]): void {
  const list = el("connectionsList");
  list.textContent = "";
  if (connections.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Belum ada situs terhubung.";
    list.appendChild(empty);
    return;
  }
  for (const connection of connections) {
    const row = document.createElement("p");
    const origin = document.createElement("span");
    origin.className = "mono";
    origin.textContent = connection.origin;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Cabut";
    button.style.marginLeft = "8px";
    button.addEventListener("click", () => {
      button.disabled = true;
      void call<{ connections: Connection[] }>("disconnectOrigin", {
        origin: connection.origin,
      })
        .then((result) => renderConnectionsList(result.connections))
        .catch(() => {
          button.disabled = false;
        });
    });
    row.appendChild(origin);
    row.appendChild(button);
    list.appendChild(row);
  }
}

async function renderConnections(): Promise<void> {
  try {
    const result = await call<{ connections: Connection[] }>("getConnections");
    renderConnectionsList(result.connections);
  } catch {
    // The wallet view stays usable without the connections list.
  }
}

function statusLabel(entry: ActivityEntry): string {
  return entry.status === "confirmed"
    ? "terkonfirmasi"
    : entry.status === "pending"
      ? "menunggu konfirmasi"
      : "internal";
}

function renderActivityList(entries: ActivityEntry[]): void {
  const list = el("activityList");
  list.textContent = "";
  const visible = entries.filter((entry) => entry.status !== "internal");
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Belum ada koin masuk.";
    list.appendChild(empty);
    return;
  }
  for (const entry of visible) {
    const row = document.createElement("p");
    const when = new Date(entry.firstSeenAt).toLocaleString();
    row.textContent =
      `+${formatAmount(entry.amount, displayUnit)} — ${statusLabel(entry)} — ${when}`;
    list.appendChild(row);
  }
}

async function renderActivity(): Promise<void> {
  try {
    const result = await call<{ entries: ActivityEntry[]; enabled: boolean }>(
      "getActivity",
    );
    el<HTMLInputElement>("notificationsToggle").checked = result.enabled;
    renderActivityList(result.entries);
  } catch {
    // The wallet view stays usable without the activity list.
  }
}

async function renderLastSend(): Promise<void> {
  try {
    const result = await call<{ lastSend: LastSend | null }>("getLastSend");
    const line = el("lastSend");
    const last = result.lastSend;
    if (!last) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    if (last.ok) {
      line.textContent =
        `Kirim terakhir: ${formatAmount(last.amount, displayUnit)} ke ${last.to} — txid ${last.txid ?? "—"}` +
        (last.rbf ? " (bisa diganti)" : "");
    } else {
      line.textContent = `Kirim terakhir gagal: ${last.error ?? "kesalahan tidak diketahui"}`;
    }
  } catch {
    // The wallet view stays usable without the last-send line.
  }
}

function renderAddressBookList(entries: AddressBookEntry[]): void {
  const list = el("addressBookList");
  list.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Belum ada alamat tersimpan.";
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("p");
    const text = document.createElement("span");
    text.textContent = `${entry.label} — ${entry.address}`;
    row.appendChild(text);
    const use = document.createElement("button");
    use.type = "button";
    use.textContent = "Pakai";
    use.addEventListener("click", () => {
      el<HTMLInputElement>("sendTo").value = entry.address;
      // The send form lives on its own view now; take the user there
      // so the filled address is visible.
      show("viewSend");
    });
    row.appendChild(use);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Hapus";
    remove.className = "secondary";
    remove.addEventListener("click", () => void handleAddressBookRemove(entry.id));
    row.appendChild(remove);
    list.appendChild(row);
  }
}

async function renderAddressBook(): Promise<void> {
  try {
    const result = await call<{ entries: AddressBookEntry[] }>("addressBookList");
    renderAddressBookList(result.entries);
  } catch {
    // The wallet view stays usable without the address book.
  }
}

function formatIdr(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Group a digit string with thousands separators ("8000" -> "8,000").
 * Pure string work, so no precision is lost on long inputs. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The caret position after `count` digits in `value`: walk the
 * digits, skipping the grouping separators. */
function positionAfterDigits(value: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < value.length; i++) {
    if (/\d/.test(value.charAt(i))) {
      seen += 1;
      if (seen === count) return i + 1;
    }
  }
  return value.length;
}

/** Reformat the amount field as the user types, keeping the caret
 * after the same digit. In nusan mode non-digits are dropped; in
 * NUX mode one decimal point is kept and the fraction is capped at
 * 8 digits (a fraction below 1 nusan does not exist). */
function formatAmountInput(input: HTMLInputElement): void {
  const raw = input.value;
  const caret = input.selectionStart ?? raw.length;
  if (displayUnit === "nux") {
    const dotIndex = raw.indexOf(".");
    const wholeRaw = dotIndex === -1 ? raw : raw.slice(0, dotIndex);
    const fracRaw = dotIndex === -1 ? "" : raw.slice(dotIndex + 1);
    const wholeDigits = wholeRaw.replace(/\D/g, "");
    const fracDigits = fracRaw.replace(/\D/g, "").slice(0, 8);
    const hasDot = dotIndex !== -1;
    const grouped = wholeDigits === "" ? "" : groupThousands(wholeDigits);
    // A leading dot becomes "0." so the value always parses.
    const wholeText = grouped === "" && hasDot ? "0" : grouped;
    input.value = hasDot ? `${wholeText}.${fracDigits}` : wholeText;
    let position: number;
    if (!hasDot || caret <= dotIndex) {
      const digitsBeforeCaret = raw
        .slice(0, caret)
        .replace(/\D/g, "").length;
      position = positionAfterDigits(input.value, digitsBeforeCaret);
    } else {
      const fracBeforeCaret = raw
        .slice(dotIndex + 1, caret)
        .replace(/\D/g, "").length;
      position =
        input.value.indexOf(".") + 1 + Math.min(fracBeforeCaret, fracDigits.length);
    }
    input.setSelectionRange(position, position);
    return;
  }
  const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, "").length;
  const digits = raw.replace(/\D/g, "");
  input.value = digits === "" ? "" : groupThousands(digits);
  const position = positionAfterDigits(input.value, digitsBeforeCaret);
  input.setSelectionRange(position, position);
}

function formatNuxPriceIdr(value: number): string {
  // Below Rp1 the 2-decimal display loses the price; keep 4.
  const digits = value >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

async function renderMarket(status: StatusResult): Promise<void> {
  const section = el("marketInfo");
  try {
    const result = await call<{ market: MarketInfo | null }>("getMarketInfo");
    const market = result.market;
    if (!market) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const change =
      market.changePct === null
        ? ""
        : ` (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(1)}% 24h)`;
    const updated = new Date(market.fetchedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (market.priceIdr !== null) {
      setText(
        "marketPrice",
        `1 NUX ≈ Rp${formatNuxPriceIdr(market.priceIdr)}${change}`,
      );
    } else {
      // The IDR rate is unavailable; fall back to the USDT price.
      setText(
        "marketPrice",
        `1 NUX ≈ $${market.lastUsdt.toFixed(6)} USDT${change}`,
      );
    }
    setText(
      "marketSource",
      `Harga pasar — qutrade.io · diperbarui ${updated}`,
    );
    const equivalent = el("marketEquivalent");
    const total =
      (status.confirmedBalance ?? 0) + (status.unconfirmedBalance ?? 0);
    if (market.priceIdr !== null && total > 0) {
      // 1 NUX = 100,000,000 nusan.
      const idr = (total / 100_000_000) * market.priceIdr;
      equivalent.textContent = `Saldo ≈ Rp${formatIdr(idr)}`;
      equivalent.hidden = false;
    } else if (
      status.confirmedBalance === null &&
      status.unconfirmedBalance === null
    ) {
      // A failed refresh: keep the previous equivalent, same rule as
      // the balances in renderWallet.
    } else {
      equivalent.hidden = true;
    }
  } catch {
    // No market data, no market section — never an error.
    section.hidden = true;
  }
}

async function handleAddressBookAdd(): Promise<void> {
  const label = el<HTMLInputElement>("addressBookLabel").value.trim();
  const address = el<HTMLInputElement>("addressBookAddress").value.trim();
  setText("addressBookError", "");
  if (!label) {
    setText("addressBookError", "Masukkan label.");
    return;
  }
  if (!address) {
    setText("addressBookError", "Masukkan alamat.");
    return;
  }
  try {
    await call<unknown>("addressBookAdd", { label, address });
    el<HTMLInputElement>("addressBookLabel").value = "";
    el<HTMLInputElement>("addressBookAddress").value = "";
    await renderAddressBook();
  } catch (error) {
    setText(
      "addressBookError",
      error instanceof Error ? error.message : "Tidak bisa menambah alamat.",
    );
  }
}

async function handleAddressBookRemove(id: string): Promise<void> {
  try {
    await call<unknown>("addressBookRemove", { id });
    await renderAddressBook();
  } catch {
    // The entry stays listed; the next refresh retries the view.
  }
}

async function handleSend(): Promise<void> {
  const to = el<HTMLInputElement>("sendTo").value.trim();
  // The amount field shows thousands separators while typing; strip
  // them before validation.
  const amountText = el<HTMLInputElement>("sendAmount").value
    .trim()
    .replace(/,/g, "");
  const rbf = el<HTMLInputElement>("sendRbf").checked;
  const button = el<HTMLButtonElement>("sendSubmit");
  setText("sendError", "");
  if (!to) {
    setText("sendError", "Masukkan alamat penerima.");
    return;
  }
  // In NUX mode the user types a decimal; it converts to whole
  // nusan here, so everything downstream still works in integers.
  let amount: number;
  if (displayUnit === "nux") {
    const parsed = nuxStringToNusan(amountText);
    if (parsed === null) {
      setText(
        "sendError",
        "Jumlah harus bilangan desimal NUX (maks 8 angka di belakang koma).",
      );
      return;
    }
    amount = parsed;
  } else {
    if (!/^\d+$/.test(amountText)) {
      setText("sendError", "Jumlah harus bilangan bulat nusan.");
      return;
    }
    amount = Number(amountText);
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    setText(
      "sendError",
      displayUnit === "nux"
        ? "Jumlah harus lebih dari 0 NUX."
        : "Jumlah harus bilangan bulat positif nusan.",
    );
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Preparing…";
  try {
    // The background returns the draft summary with its pending id;
    // the review happens here, in this popup. The form keeps its
    // values until the send executes, so a rejection returns to an
    // editable form.
    const result = await call<{ summary: SendSummary; id: string }>(
      "popupSendDraft",
      { to, amount, rbf },
    );
    showReview({ id: result.id, summary: result.summary });
  } catch (error) {
    setText(
      "sendError",
      error instanceof Error ? error.message : "Tidak bisa menyiapkan pengiriman.",
    );
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function handleSendMax(): Promise<void> {
  const button = el<HTMLButtonElement>("sendMax");
  setText("sendError", "");
  button.disabled = true;
  try {
    const result = await call<{ amount: number; fee: number; feeRate: number }>(
      "getMaxSendable",
    );
    const input = el<HTMLInputElement>("sendAmount");
    input.value = formatAmountValue(result.amount, displayUnit);
    formatAmountInput(input);
  } catch (error) {
    setText(
      "sendError",
      error instanceof Error
        ? error.message
        : "Tidak bisa menghitung jumlah maksimum.",
    );
  } finally {
    button.disabled = false;
  }
}

/** The pending wallet send under inline review, if any. */
let reviewPendingId: string | null = null;

/** Render a draft summary into the review view and show it. Amounts
 * follow the popup's current display unit. */
function showReview(pending: PendingWalletSend): void {
  reviewPendingId = pending.id;
  const summary = pending.summary;
  // The network the send executes on. A switch kills the review
  // (the pending belongs to the old network), so the active network
  // shown here is always the draft's network while the review is
  // visible.
  setText(
    "reviewNetwork",
    currentNetwork === "testnet" ? "Testnet — koin uji" : "Mainnet — dana sungguhan",
  );
  setText("reviewTo", summary.to);
  setText("reviewAmount", formatAmount(summary.amount, displayUnit));
  setText(
    "reviewFee",
    `${formatAmount(summary.fee, displayUnit)} (dengan ${summary.feeRate} nusan/vbyte)`,
  );
  setText("reviewTotal", formatAmount(summary.total, displayUnit));
  setText(
    "reviewChange",
    summary.changeAddress
      ? `${formatAmount(summary.changeValue, displayUnit)} ke alamat kembalian dompet ini`
      : "0 (sisanya masuk ke fee)",
  );
  setText(
    "reviewRbf",
    summary.rbf ? "Ya — transaksi ini bisa diganti" : "Tidak",
  );
  // What stays in the wallet after this send: the confirmed balance
  // minus the total out. The change is already inside that figure
  // (it comes back as a new output), so it is not added twice.
  setText(
    "reviewRemaining",
    lastConfirmedBalance === null
      ? "—"
      : formatAmount(lastConfirmedBalance - summary.total, displayUnit),
  );
  setText("reviewError", "");
  el("reviewDecideRow").hidden = false;
  el("reviewBackRow").hidden = true;
  show("viewReview");
}

async function handleReviewConfirm(): Promise<void> {
  if (reviewPendingId === null) return;
  const button = el<HTMLButtonElement>("reviewApprove");
  setText("reviewError", "");
  button.disabled = true;
  try {
    const result = await call<{ resolved: boolean; execError?: string }>(
      "popupSendConfirm",
      { id: reviewPendingId },
    );
    if (result.execError) {
      // Execution failed: the pending is settled, so there is
      // nothing left to approve — show the failure and offer the
      // way back to the form.
      setText("reviewError", result.execError);
      el("reviewDecideRow").hidden = true;
      el("reviewBackRow").hidden = false;
      return;
    }
    reviewPendingId = null;
    el<HTMLInputElement>("sendTo").value = "";
    el<HTMLInputElement>("sendAmount").value = "";
    await refresh();
  } catch (error) {
    // The pending is gone, or the vault locked mid-review: the
    // same dead end as an execution failure.
    setText(
      "reviewError",
      error instanceof Error ? error.message : "Pengiriman gagal.",
    );
    el("reviewDecideRow").hidden = true;
    el("reviewBackRow").hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function handleReviewCancel(): Promise<void> {
  if (reviewPendingId === null) {
    show("viewSend");
    return;
  }
  const button = el<HTMLButtonElement>("reviewReject");
  button.disabled = true;
  try {
    await call<{ resolved: boolean }>("popupSendCancel", {
      id: reviewPendingId,
    });
  } catch {
    // The pending may already be gone (worker restart); the user's
    // intent is to leave the review either way.
  } finally {
    button.disabled = false;
  }
  reviewPendingId = null;
  show("viewSend");
}

/** If a wallet send is awaiting its inline review (the popup closed
 * mid-review), show the review again instead of the home view. */
async function resumePendingReview(): Promise<void> {
  try {
    const result = await call<{ pending: PendingWalletSend | null }>(
      "getPendingWalletSend",
    );
    if (result.pending) showReview(result.pending);
  } catch {
    // No pending review, or the check failed — stay home.
  }
}

/** The currently visible view, if any. */
function currentView(): (typeof VIEWS)[number] | null {
  for (const id of VIEWS) {
    if (!el(id).hidden) return id;
  }
  return null;
}

async function refresh(): Promise<void> {
  // A refresh that started on one view must not yank the user back
  // when it lands after they navigated away: the 5 s live refresh
  // fires on the home view, but its status read can resolve after
  // the user reached the send form or the review.
  const viewBefore = currentView();
  const status = await call<StatusResult>("getStatus");
  // Opening the popup clears the incoming-coins badge (locked rule).
  void call("notificationsOpened").catch(() => {});
  if (currentView() !== viewBefore) return;
  applyNetworkBadge(status.network);
  if (!status.hasVault) {
    setSetupMode("create");
    show("viewSetup");
  } else if (!status.unlocked) {
    show("viewUnlock");
  } else {
    renderWallet(status);
    await resumePendingReview();
  }
}

/** Live refresh: while the wallet view is open, re-read the status
 * every few seconds so the balance, tip height, and activity list
 * track new blocks without reopening the popup. Skipped while a
 * refresh is already in flight, and paused on the setup/unlock
 * views (nothing there changes on its own). The interval dies with
 * the popup document; no cleanup is needed. */
const POPUP_REFRESH_MS = 5000;
let refreshInFlight = false;

async function refreshGuarded(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    await refresh();
  } catch {
    // The next tick retries; a failed refresh must not stop the interval.
  } finally {
    refreshInFlight = false;
  }
}

async function handleSetup(): Promise<void> {
  const password = el<HTMLInputElement>("setupPassword").value;
  const confirm = el<HTMLInputElement>("setupPasswordConfirm").value;
  const button = el<HTMLButtonElement>("setupSubmit");
  setText("setupError", "");
  if (password.length < 8) {
    setText("setupError", "Kata sandi minimal 8 karakter.");
    return;
  }
  if (password !== confirm) {
    setText("setupError", "Kedua kata sandi tidak cocok.");
    return;
  }
  button.disabled = true;
  try {
    if (setupMode === "create") {
      const result = await call<{ mnemonic: string; address: string | null }>(
        "vaultCreate",
        { password },
      );
      const words = el("mnemonicWords");
      words.textContent = "";
      result.mnemonic.split(" ").forEach((word, i) => {
        const span = document.createElement("span");
        span.textContent = `${i + 1}. ${word}`;
        words.appendChild(span);
      });
      show("viewMnemonic");
    } else {
      const mnemonic = el<HTMLTextAreaElement>("importMnemonic").value;
      await call<{ address: string | null }>("vaultImport", { mnemonic, password });
      await refresh();
    }
  } catch (error) {
    setText(
      "setupError",
      error instanceof Error ? error.message : "Penyiapan gagal.",
    );
  } finally {
    button.disabled = false;
  }
}

async function handleUnlock(): Promise<void> {
  const password = el<HTMLInputElement>("unlockPassword").value;
  const button = el<HTMLButtonElement>("unlockSubmit");
  setText("unlockError", "");
  button.disabled = true;
  try {
    await call<{ unlocked: boolean }>("vaultUnlock", { password });
    el<HTMLInputElement>("unlockPassword").value = "";
    await refresh();
  } catch (error) {
    setText(
      "unlockError",
      error instanceof Error ? error.message : "Membuka kunci gagal.",
    );
  } finally {
    button.disabled = false;
  }
}

// The wallet note's default text (the testnet explainer in the
// markup), captured before the first refresh so a backend-error note
// can be replaced by it again once the backend recovers.
let walletNoteDefault = "";

document.addEventListener("DOMContentLoaded", () => {
  walletNoteDefault = el("walletNote").textContent;
  el("sendAmount").addEventListener("input", () => {
    formatAmountInput(el<HTMLInputElement>("sendAmount"));
  });
  // Show the running version in the footer, so a field test can
  // confirm at a glance which build is loaded.
  setText("versionText", `NUX Connect v${chrome.runtime.getManifest().version}`);
  setInterval(() => {
    if (!el("viewWallet").hidden) void refreshGuarded();
  }, POPUP_REFRESH_MS);
  el("tabCreate").addEventListener("click", () => setSetupMode("create"));
  el("tabImport").addEventListener("click", () => setSetupMode("import"));
  el("setupSubmit").addEventListener("click", () => void handleSetup());
  el("mnemonicConfirm").addEventListener("click", () => void refresh());
  el("unlockSubmit").addEventListener("click", () => void handleUnlock());
  // The password field is not inside a <form>, so Enter does nothing
  // by itself — wire it to unlock, the same action as the button. The
  // disabled check is the in-flight signal handleUnlock manages, so a
  // fast double-Enter cannot start a second unlock while one runs.
  el("unlockPassword").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (el<HTMLButtonElement>("unlockSubmit").disabled) return;
    void handleUnlock();
  });
  el("lockSubmit").addEventListener("click", () => {
    void call("vaultLock").then(() => refresh());
  });
  el("unitToggle").addEventListener("click", () => void handleUnitToggle());
  el("networkBadge").addEventListener("click", () => void handleNetworkBadgeClick());
  el("networkConfirmOk").addEventListener("click", () => void handleNetworkConfirm());
  el("networkConfirmCancel").addEventListener("click", () => handleNetworkConfirmCancel());
  el("navSend").addEventListener("click", () => show("viewSend"));
  el("navReceive").addEventListener("click", () => show("viewReceive"));
  el("sendBack").addEventListener("click", () => show("viewWallet"));
  el("receiveBack").addEventListener("click", () => show("viewWallet"));
  el("homeCopy").addEventListener("click", () => {
    void copyText(
      el("walletAddress").textContent ?? "",
      el<HTMLButtonElement>("homeCopy"),
    );
  });
  el("receiveCopy").addEventListener("click", () => {
    void copyText(
      el("receiveAddress").textContent ?? "",
      el<HTMLButtonElement>("receiveCopy"),
    );
  });
  el("receiveRefresh").addEventListener("click", () => void handleReceiveRefresh());
  el("sendSubmit").addEventListener("click", () => void handleSend());
  el("sendMax").addEventListener("click", () => void handleSendMax());
  el("reviewApprove").addEventListener("click", () => void handleReviewConfirm());
  el("reviewReject").addEventListener("click", () => void handleReviewCancel());
  el("reviewBack").addEventListener("click", () => show("viewSend"));
  el("addressBookAdd").addEventListener("click", () => void handleAddressBookAdd());
  el("notificationsToggle").addEventListener("change", (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void call<{ enabled: boolean }>("setNotificationsEnabled", { enabled })
      .then((result) => {
        el<HTMLInputElement>("notificationsToggle").checked = result.enabled;
      })
      .catch(() => {
        el<HTMLInputElement>("notificationsToggle").checked = !enabled;
      });
  });
  // Load the display unit before the first render, so the first
  // paint already shows the user's unit instead of flashing nusan.
  void (async () => {
    try {
      const result = await call<{ unit: DisplayUnit }>("getDisplayUnit");
      displayUnit = parseDisplayUnit(result.unit);
    } catch {
      displayUnit = "nusan";
    }
    // The mainnet acknowledgment flag decides whether the badge
    // switch to mainnet shows its confirmation card.
    try {
      const network = await call<{
        network: string;
        mainnetAcknowledged: boolean;
      }>("getNetwork");
      mainnetAcknowledged = network.mainnetAcknowledged === true;
    } catch {
      mainnetAcknowledged = false;
    }
    applyDisplayUnit();
    try {
      await refresh();
    } catch (error: unknown) {
      setText(
        "viewLoading",
        `Tidak bisa menghubungi background worker: ${
          error instanceof Error ? error.message : "kesalahan tidak diketahui"
        }`,
      );
      show("viewLoading");
    }
  })();
});

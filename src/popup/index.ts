// Toolbar popup: wallet setup, unlock, and status.
//
// The popup never touches secrets beyond forwarding the password (and,
// at import, the pasted phrase) to the background worker over the
// extension's internal message channel, and showing the freshly
// generated recovery phrase exactly once after creation. All vault
// logic lives in the background (src/lib/vault.ts).

import "../lib/globals";

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
  | "getLastSend"
  | "addressBookList"
  | "addressBookAdd"
  | "addressBookRemove"
  | "getMarketInfo"
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

const VIEWS = ["viewLoading", "viewSetup", "viewMnemonic", "viewUnlock", "viewWallet"] as const;

function show(view: (typeof VIEWS)[number]): void {
  for (const id of VIEWS) {
    el(id).hidden = id !== view;
  }
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

let setupMode: "create" | "import" = "create";

function setSetupMode(mode: "create" | "import"): void {
  setupMode = mode;
  el("paneCreate").hidden = mode !== "create";
  el("paneImport").hidden = mode !== "import";
  el("tabCreate").className = mode === "create" ? "" : "secondary";
  el("tabImport").className = mode === "import" ? "" : "secondary";
  setText("setupError", "");
}

function renderWallet(status: StatusResult): void {
  setText(
    "networkBadge",
    status.network === "testnet" ? "TESTNET" : status.network.toUpperCase(),
  );
  setText("networkName", `${status.networkLabel} (${status.network})`);
  setText("walletAddress", status.address ?? "—");
  // A failed refresh returns null figures: keep the last-known values
  // instead of blanking them to dashes. The initial "—" in the markup
  // survives untouched until the first successful read, and the note
  // below still says the backend failed.
  if (status.confirmedBalance !== null) {
    setText("confirmedBalance", formatNusan(status.confirmedBalance));
  }
  if (status.unconfirmedBalance !== null) {
    setText("unconfirmedBalance", formatNusan(status.unconfirmedBalance));
  }
  if (status.tipHeight !== null) {
    setText("tipHeight", String(status.tipHeight));
  }
  if (status.feeRate !== null) {
    setText("feeRate", String(status.feeRate));
  }
  if (status.statusError) {
    setText("walletNote", `Backend status: ${status.statusError}`);
  } else {
    setText("walletNote", walletNoteDefault);
  }
  show("viewWallet");
  void renderConnections();
  void renderActivity();
  void renderLastSend();
  void renderAddressBook();
  void renderMarket(status);
}

function renderConnectionsList(connections: Connection[]): void {
  const list = el("connectionsList");
  list.textContent = "";
  if (connections.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No sites connected yet.";
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
    button.textContent = "Disconnect";
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
    empty.textContent = "No incoming coins yet.";
    list.appendChild(empty);
    return;
  }
  for (const entry of visible) {
    const row = document.createElement("p");
    const when = new Date(entry.firstSeenAt).toLocaleString();
    row.textContent =
      `+${entry.amount} nusan — ${statusLabel(entry)} — ${when}`;
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
        `Last send: ${last.amount} nusan to ${last.to} — txid ${last.txid ?? "—"}` +
        (last.rbf ? " (replaceable)" : "");
    } else {
      line.textContent = `Last send failed: ${last.error ?? "unknown error"}`;
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
    empty.textContent = "No saved addresses yet.";
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
    use.textContent = "Use";
    use.addEventListener("click", () => {
      el<HTMLInputElement>("sendTo").value = entry.address;
    });
    row.appendChild(use);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
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

/** Whole-nusan amounts with thousands separators ("318210" -> "318,210"). */
function formatNusan(value: number): string {
  return value.toLocaleString("en-US");
}

/** Group a digit string with thousands separators ("8000" -> "8,000").
 * Pure string work, so no precision is lost on long inputs. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Reformat the amount field as the user types, keeping the caret
 * after the same digit. Non-digits are dropped. */
function formatAmountInput(input: HTMLInputElement): void {
  const caret = input.selectionStart ?? input.value.length;
  const digitsBeforeCaret = input.value
    .slice(0, caret)
    .replace(/\D/g, "").length;
  const digits = input.value.replace(/\D/g, "");
  input.value = digits === "" ? "" : groupThousands(digits);
  let position = 0;
  if (digitsBeforeCaret > 0) {
    let seen = 0;
    position = input.value.length;
    for (let i = 0; i < input.value.length; i++) {
      if (/\d/.test(input.value.charAt(i))) {
        seen += 1;
        if (seen === digitsBeforeCaret) {
          position = i + 1;
          break;
        }
      }
    }
  }
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
      `Market price — qutrade.io / Indodax · updated ${updated}`,
    );
    const equivalent = el("marketEquivalent");
    const total =
      (status.confirmedBalance ?? 0) + (status.unconfirmedBalance ?? 0);
    if (market.priceIdr !== null && total > 0) {
      // 1 NUX = 100,000,000 nusan.
      const idr = (total / 100_000_000) * market.priceIdr;
      equivalent.textContent = `Balance ≈ Rp${formatIdr(idr)}`;
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
    setText("addressBookError", "Enter a label.");
    return;
  }
  if (!address) {
    setText("addressBookError", "Enter an address.");
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
      error instanceof Error ? error.message : "Could not add the address.",
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
  // them before the whole-number validation.
  const amountText = el<HTMLInputElement>("sendAmount").value
    .trim()
    .replace(/,/g, "");
  const rbf = el<HTMLInputElement>("sendRbf").checked;
  const button = el<HTMLButtonElement>("sendSubmit");
  setText("sendError", "");
  if (!to) {
    setText("sendError", "Enter a recipient address.");
    return;
  }
  if (!/^\d+$/.test(amountText)) {
    setText("sendError", "Amount must be a whole number of nusan.");
    return;
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    setText("sendError", "Amount must be a positive integer number of nusan.");
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Preparing…";
  try {
    // Returns once the approval window is open; the decision itself
    // happens there, and the result is recorded for this popup to
    // show on its next open.
    await call<unknown>("popupSendDraft", { to, amount, rbf });
    el<HTMLInputElement>("sendTo").value = "";
    el<HTMLInputElement>("sendAmount").value = "";
  } catch (error) {
    setText(
      "sendError",
      error instanceof Error ? error.message : "Could not prepare the send.",
    );
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function refresh(): Promise<void> {
  const status = await call<StatusResult>("getStatus");
  // Opening the popup clears the incoming-coins badge (locked rule).
  void call("notificationsOpened").catch(() => {});
  setText(
    "networkBadge",
    status.network === "testnet" ? "TESTNET" : status.network.toUpperCase(),
  );
  if (!status.hasVault) {
    setSetupMode("create");
    show("viewSetup");
  } else if (!status.unlocked) {
    show("viewUnlock");
  } else {
    renderWallet(status);
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
    setText("setupError", "Password must be at least 8 characters.");
    return;
  }
  if (password !== confirm) {
    setText("setupError", "The two passwords do not match.");
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
      error instanceof Error ? error.message : "Setup failed.",
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
      error instanceof Error ? error.message : "Unlock failed.",
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
  el("sendSubmit").addEventListener("click", () => void handleSend());
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
  void refresh().catch((error: unknown) => {
    setText(
      "viewLoading",
      `Could not reach the background worker: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    show("viewLoading");
  });
});

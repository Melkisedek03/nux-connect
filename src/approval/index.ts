// Approval window: renders one pending provider request.
//
// The window exists because the toolbar popup closes when it loses
// focus — an unsafe place for a decision. This page is an extension
// page, so it may use the internal message channel; it never sees the
// recovery phrase, and request details (addresses, amounts, message
// text) are handed to it only while the vault is unlocked. Sends the
// wallet itself starts (from the popup) approve inline in the popup
// instead; this window serves dApp requests only.
//
// Flow: read the request id from the URL, ask the background for the
// request state, then render one view per state and kind — an error
// (request gone, or no wallet yet), an unlock form (vault locked), or
// the decision itself: a connection prompt, a payment review, a
// message-signing review, or a PSBT review. What is shown is exactly
// what executes on approval. Approving settles the waiting provider
// call with the execution result; rejecting — or closing this window —
// settles it with error 4001. If execution itself fails (for example a
// rejected broadcast), the failure text is shown here and the waiting
// call settles with that failure.

import "../lib/globals";
import {
  formatAmount,
  formatAmountValue,
  parseDisplayUnit,
  type DisplayUnit,
} from "../lib/units";

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

interface PsbtSummary {
  inputs: { address: string | null; value: number }[];
  outputs: { address: string | null; value: number }[];
  totalIn: number;
  totalOut: number;
  fee: number;
  feeRate: number;
}

interface ApprovalRequestView {
  id: string;
  origin: string;
  kind: "connect" | "send" | "signMessage" | "signPsbt" | "sendPsbt";
  network: string;
  networkLabel: string;
  hasVault: boolean;
  unlocked: boolean;
  alreadyConnected: boolean;
  address: string | null;
  sendSummary?: SendSummary;
  message?: string;
  psbtSummary?: PsbtSummary;
}

type InternalRequest =
  | "getApprovalRequest"
  | "resolveApproval"
  | "vaultUnlock"
  | "getDisplayUnit";

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
  "viewError",
  "viewUnlock",
  "viewConnect",
  "viewSend",
  "viewSignMessage",
  "viewPsbt",
] as const;

/**
 * Resize this window to fit its content exactly. chrome.windows.create
 * sizes the OUTER window (frame + title bar included), so a fixed
 * 400x600 window clips a 400px-wide page and scrolls a taller one.
 * The frame size is measured live (outer minus inner), and the height
 * is capped at the available screen so a long PSBT still scrolls
 * instead of running off the display. Cosmetic only: a failure here
 * must never break the approval flow.
 */
async function fitWindow(): Promise<void> {
  try {
    const frameWidth = window.outerWidth - window.innerWidth;
    const frameHeight = window.outerHeight - window.innerHeight;
    const width =
      Math.ceil(document.documentElement.scrollWidth) + frameWidth;
    const height = Math.min(
      Math.ceil(document.documentElement.scrollHeight) + frameHeight,
      Math.floor(window.screen.availHeight * 0.95),
    );
    const win = await chrome.windows.getCurrent();
    if (win.id === undefined) return;
    if (win.width !== width || win.height !== height) {
      await chrome.windows.update(win.id, { width, height });
    }
  } catch {
    // Sizing is cosmetic; never break the approval flow.
  }
}

function show(view: (typeof VIEWS)[number]): void {
  for (const id of VIEWS) {
    el(id).hidden = id !== view;
  }
  // Every view has its own height; resize after each switch.
  void fitWindow();
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

const requestId = new URLSearchParams(location.search).get("id") ?? "";

function showError(message: string): void {
  setText("errorMessage", message);
  show("viewError");
}

function networkNote(view: ApprovalRequestView): string {
  return `Jaringan: ${view.networkLabel} (${view.network}).`;
}

/**
 * The wallet itself, for approvals the popup starts (no dApp origin):
 * the background uses the sentinel "wallet", rendered here as
 * "Dompet ini".
 */
const WALLET_ORIGIN = "wallet";

function displayOrigin(origin: string): string {
  return origin === WALLET_ORIGIN ? "Dompet ini" : origin;
}

async function load(): Promise<void> {
  show("viewLoading");
  let view: ApprovalRequestView;
  try {
    view = await call<ApprovalRequestView>("getApprovalRequest", {
      id: requestId,
    });
  } catch (error) {
    showError(
      error instanceof Error ? error.message : "Permintaan ini tidak lagi menunggu.",
    );
    return;
  }
  // Amounts follow the user's display unit (nusan by default). The
  // unit is read after the request itself, so a failed read still
  // leaves a usable approval window showing nusan.
  let unit: DisplayUnit = "nusan";
  try {
    const result = await call<{ unit: DisplayUnit }>("getDisplayUnit");
    unit = parseDisplayUnit(result.unit);
  } catch {
    // Keep the nusan default.
  }
  for (const suffix of document.querySelectorAll(".satuan")) {
    suffix.textContent = unit === "nusan" ? "nusan" : "NUX";
  }

  setText(
    "networkBadge",
    view.network === "testnet" ? "TESTNET" : view.network.toUpperCase(),
  );
  // The yellow testnet banner is testnet-only; on mainnet it hides.
  el("testnetBanner").hidden = view.network !== "testnet";

  if (!view.hasVault) {
    showError(
      "Belum ada dompet. Buat dari popup ekstensi, lalu minta situs bertanya lagi.",
    );
    return;
  }
  if (!view.unlocked) {
    setText("unlockOrigin", displayOrigin(view.origin));
    setText("unlockError", "");
    show("viewUnlock");
    return;
  }

  switch (view.kind) {
    case "connect": {
      setText("connectOrigin", displayOrigin(view.origin));
      setText("connectAddress", view.address ?? "—");
      setText("connectNetworkNote", networkNote(view));
      setText("connectError", "");
      if (view.alreadyConnected) {
        setText("connectTitle", "Situs ini sudah terhubung");
        setText("connectSubmit", "Lanjut");
      } else {
        setText("connectTitle", "Sebuah situs ingin terhubung");
        setText("connectSubmit", "Hubungkan");
      }
      show("viewConnect");
      return;
    }
    case "send": {
      const summary = view.sendSummary;
      if (!summary) {
        showError("Rincian pembayaran tidak tersedia.");
        return;
      }
      setText("sendOrigin", displayOrigin(view.origin));
      setText("sendTo", summary.to);
      setText("sendAmount", formatAmountValue(summary.amount, unit));
      setText(
        "sendFee",
        `${formatAmount(summary.fee, unit)} (dengan ${summary.feeRate} nusan/vbyte)`,
      );
      setText("sendTotal", formatAmountValue(summary.total, unit));
      setText(
        "sendChange",
        summary.changeAddress
          ? `${formatAmount(summary.changeValue, unit)} ke alamat kembalian dompet ini`
          : "0 (sisanya masuk ke fee)",
      );
      setText(
        "sendRbf",
        summary.rbf ? "Ya — transaksi ini bisa diganti" : "Tidak",
      );
      setText("sendNetworkNote", networkNote(view));
      setText("sendError", "");
      show("viewSend");
      return;
    }
    case "signMessage": {
      if (view.message === undefined) {
        showError("Pesan tidak tersedia.");
        return;
      }
      setText("signOrigin", displayOrigin(view.origin));
      setText("signMessageText", view.message);
      setText("signNetworkNote", networkNote(view));
      setText("signError", "");
      show("viewSignMessage");
      return;
    }
    case "signPsbt":
    case "sendPsbt": {
      const summary = view.psbtSummary;
      if (!summary) {
        showError("Rincian PSBT tidak tersedia.");
        return;
      }
      setText("psbtTitle",
        view.kind === "signPsbt" ? "Tandatangani PSBT ini?" : "Tandatangani dan kirim PSBT ini?");
      setText("psbtSubmit",
        view.kind === "signPsbt" ? "Tandatangani" : "Tandatangani dan kirim");
      setText("psbtOrigin", displayOrigin(view.origin));
      setText("psbtTotalIn", formatAmountValue(summary.totalIn, unit));
      setText("psbtTotalOut", formatAmountValue(summary.totalOut, unit));
      setText(
        "psbtFee",
        `${formatAmount(summary.fee, unit)} (tarif tersirat ${summary.feeRate} nusan/vbyte)`,
      );
      setText(
        "psbtOutputs",
        summary.outputs
          .map(
            (output) =>
              `${output.address ?? "(skrip tidak dikenal)"} — ${formatAmount(output.value, unit)}`,
          )
          .join("\n"),
      );
      setText("psbtNetworkNote", networkNote(view));
      setText("psbtError", "");
      show("viewPsbt");
      return;
    }
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
    await load();
  } catch (error) {
    setText(
      "unlockError",
      error instanceof Error ? error.message : "Membuka kunci gagal.",
    );
  } finally {
    button.disabled = false;
  }
}

async function handleResolve(
  approved: boolean,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const result = await call<{ resolved: boolean; execError?: string }>(
      "resolveApproval",
      { id: requestId, approved },
    );
    if (result.execError) {
      showError(result.execError);
      return;
    }
    window.close();
  } catch (error) {
    button.disabled = false;
    if (!approved) {
      // A rejection that could not be delivered still ends the flow.
      window.close();
      return;
    }
    // Most likely the vault auto-locked while deciding; reload renders
    // the unlock view in that case.
    await load();
    if (error instanceof Error) {
      for (const id of ["connectError", "sendError", "signError", "psbtError"]) {
        setText(id, error.message);
      }
    }
  }
}

async function handleRejectFromUnlock(): Promise<void> {
  try {
    await call<{ resolved: boolean }>("resolveApproval", {
      id: requestId,
      approved: false,
    });
  } catch {
    // The request may already be gone; closing is the user's intent.
  }
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  el("errorClose").addEventListener("click", () => window.close());
  el("unlockSubmit").addEventListener("click", () => void handleUnlock());
  el("unlockReject").addEventListener("click", () => void handleRejectFromUnlock());
  document
    .querySelectorAll<HTMLButtonElement>(".js-approve")
    .forEach((button) =>
      button.addEventListener("click", () => void handleResolve(true, button)),
    );
  document
    .querySelectorAll<HTMLButtonElement>(".js-reject")
    .forEach((button) =>
      button.addEventListener("click", () => void handleResolve(false, button)),
    );
  if (!requestId) {
    showError("Jendela ini dibuka tanpa id permintaan.");
    return;
  }
  void load();
});

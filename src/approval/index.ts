// Approval window: renders one pending provider request.
//
// The window exists because the toolbar popup closes when it loses
// focus — an unsafe place for a decision. This page is an extension
// page, so it may use the internal message channel; it never sees the
// recovery phrase, and request details (addresses, amounts, message
// text) are handed to it only while the vault is unlocked.
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

interface SendSummary {
  to: string;
  amount: number;
  fee: number;
  feeRate: number;
  total: number;
  changeAddress: string | null;
  changeValue: number;
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

type InternalRequest = "getApprovalRequest" | "resolveApproval" | "vaultUnlock";

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

function show(view: (typeof VIEWS)[number]): void {
  for (const id of VIEWS) {
    el(id).hidden = id !== view;
  }
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
  return `Network: ${view.networkLabel} (${view.network}).`;
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
      error instanceof Error ? error.message : "This request is no longer pending.",
    );
    return;
  }

  setText(
    "networkBadge",
    view.network === "testnet" ? "TESTNET" : view.network.toUpperCase(),
  );

  if (!view.hasVault) {
    showError(
      "No wallet exists yet. Create one from the extension popup, then let the site ask again.",
    );
    return;
  }
  if (!view.unlocked) {
    setText("unlockOrigin", view.origin);
    setText("unlockError", "");
    show("viewUnlock");
    return;
  }

  switch (view.kind) {
    case "connect": {
      setText("connectOrigin", view.origin);
      setText("connectAddress", view.address ?? "—");
      setText("connectNetworkNote", networkNote(view));
      setText("connectError", "");
      if (view.alreadyConnected) {
        setText("connectTitle", "This site is already connected");
        setText("connectSubmit", "Continue");
      } else {
        setText("connectTitle", "A site wants to connect");
        setText("connectSubmit", "Connect");
      }
      show("viewConnect");
      return;
    }
    case "send": {
      const summary = view.sendSummary;
      if (!summary) {
        showError("The payment details are unavailable.");
        return;
      }
      setText("sendOrigin", view.origin);
      setText("sendTo", summary.to);
      setText("sendAmount", String(summary.amount));
      setText("sendFee", `${summary.fee} (at ${summary.feeRate} nusan/vbyte)`);
      setText("sendTotal", String(summary.total));
      setText(
        "sendChange",
        summary.changeAddress
          ? `${summary.changeValue} to this wallet's change address`
          : "0 (the remainder goes to the fee)",
      );
      setText("sendNetworkNote", networkNote(view));
      setText("sendError", "");
      show("viewSend");
      return;
    }
    case "signMessage": {
      if (view.message === undefined) {
        showError("The message is unavailable.");
        return;
      }
      setText("signOrigin", view.origin);
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
        showError("The PSBT details are unavailable.");
        return;
      }
      setText("psbtTitle",
        view.kind === "signPsbt" ? "Sign this PSBT?" : "Sign and send this PSBT?");
      setText("psbtSubmit",
        view.kind === "signPsbt" ? "Sign" : "Sign and send");
      setText("psbtOrigin", view.origin);
      setText("psbtTotalIn", String(summary.totalIn));
      setText("psbtTotalOut", String(summary.totalOut));
      setText("psbtFee", `${summary.fee} (implied rate ${summary.feeRate} nusan/vbyte)`);
      setText(
        "psbtOutputs",
        summary.outputs
          .map((output) => `${output.address ?? "(unknown script)"} — ${output.value}`)
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
      error instanceof Error ? error.message : "Unlock failed.",
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
    showError("This window was opened without a request id.");
    return;
  }
  void load();
});

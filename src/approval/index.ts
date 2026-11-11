// Approval window: renders one pending connection request.
//
// The window exists because the toolbar popup closes when it loses
// focus — an unsafe place for a decision. This page is an extension
// page, so it may use the internal message channel; it never sees the
// recovery phrase, and it receives the wallet address only while the
// vault is unlocked.
//
// Flow: read the request id from the URL, ask the background for the
// request state, then render one of three views — an error (request
// gone, or no wallet yet), an unlock form (vault locked), or the
// connection prompt itself (origin, network, address, Connect/Reject).
// Approving settles the waiting `nux_requestAccounts` call; rejecting —
// or closing this window — settles it with error 4001.

import "../lib/globals";

interface ApprovalRequestView {
  id: string;
  origin: string;
  network: string;
  networkLabel: string;
  hasVault: boolean;
  unlocked: boolean;
  alreadyConnected: boolean;
  address: string | null;
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

const VIEWS = ["viewLoading", "viewError", "viewUnlock", "viewConnect"] as const;

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
      "No wallet exists yet. Create one from the extension popup, then let the site ask to connect again.",
    );
    return;
  }
  if (!view.unlocked) {
    setText("unlockOrigin", view.origin);
    setText("unlockError", "");
    show("viewUnlock");
    return;
  }

  setText("connectOrigin", view.origin);
  setText("connectAddress", view.address ?? "—");
  setText(
    "connectNetworkNote",
    `Network: ${view.networkLabel} (${view.network}).`,
  );
  setText("connectError", "");
  if (view.alreadyConnected) {
    setText("connectTitle", "This site is already connected");
    setText("connectSubmit", "Continue");
  } else {
    setText("connectTitle", "A site wants to connect");
    setText("connectSubmit", "Connect");
  }
  show("viewConnect");
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

async function handleResolve(approved: boolean): Promise<void> {
  const button = el<HTMLButtonElement>(
    approved ? "connectSubmit" : "connectReject",
  );
  button.disabled = true;
  try {
    await call<{ resolved: boolean }>("resolveApproval", {
      id: requestId,
      approved,
    });
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
    setText(
      "connectError",
      error instanceof Error ? error.message : "Could not resolve the request.",
    );
    await load();
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
  el("connectSubmit").addEventListener("click", () => void handleResolve(true));
  el("connectReject").addEventListener("click", () => void handleResolve(false));
  if (!requestId) {
    showError("This window was opened without a request id.");
    return;
  }
  void load();
});

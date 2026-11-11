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

type InternalRequest =
  | "getStatus"
  | "vaultCreate"
  | "vaultImport"
  | "vaultUnlock"
  | "vaultLock"
  | "getConnections"
  | "disconnectOrigin";

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
  setText(
    "confirmedBalance",
    status.confirmedBalance !== null ? String(status.confirmedBalance) : "—",
  );
  setText(
    "unconfirmedBalance",
    status.unconfirmedBalance !== null ? String(status.unconfirmedBalance) : "—",
  );
  setText("tipHeight", status.tipHeight !== null ? String(status.tipHeight) : "—");
  setText("feeRate", status.feeRate !== null ? String(status.feeRate) : "—");
  if (status.statusError) {
    setText("walletNote", `Backend status: ${status.statusError}`);
  }
  show("viewWallet");
  void renderConnections();
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

async function refresh(): Promise<void> {
  const status = await call<StatusResult>("getStatus");
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

document.addEventListener("DOMContentLoaded", () => {
  el("tabCreate").addEventListener("click", () => setSetupMode("create"));
  el("tabImport").addEventListener("click", () => setSetupMode("import"));
  el("setupSubmit").addEventListener("click", () => void handleSetup());
  el("mnemonicConfirm").addEventListener("click", () => void refresh());
  el("unlockSubmit").addEventListener("click", () => void handleUnlock());
  el("lockSubmit").addEventListener("click", () => {
    void call("vaultLock").then(() => refresh());
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

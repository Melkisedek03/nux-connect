// Toolbar popup: shows the active network and live chain status.
//
// In this scaffold the popup is read-only. Wallet creation, balances,
// and site management arrive in later milestones.

interface StatusReply {
  ok: boolean;
  result?: {
    network: string;
    networkLabel: string;
    tipHeight: number | null;
    feeRate: number | null;
    statusError?: string;
  };
  error?: { code: number; message: string };
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage(
    { kind: "nux-internal", request: "getStatus" },
    (response: StatusReply) => {
      if (chrome.runtime.lastError || !response?.ok || !response.result) {
        setText("networkName", "Unavailable");
        setText(
          "note",
          `Could not reach the background worker: ${
            response?.error?.message ?? chrome.runtime.lastError?.message ?? "unknown error"
          }`,
        );
        return;
      }
      const status = response.result;
      setText(
        "networkBadge",
        status.network === "testnet" ? "TESTNET" : status.network.toUpperCase(),
      );
      setText("networkName", `${status.networkLabel} (${status.network})`);
      setText(
        "tipHeight",
        status.tipHeight !== null ? String(status.tipHeight) : "unreachable",
      );
      setText(
        "feeRate",
        status.feeRate !== null ? String(status.feeRate) : "unreachable",
      );
      if (status.statusError) {
        setText("note", `Backend status: ${status.statusError}`);
      }
    },
  );
});

// Approval window (scaffold).
//
// A separate window is used for approvals because the toolbar popup
// closes as soon as it loses focus — an unsafe behavior in the middle
// of an approval decision. In this milestone the window only proves its
// place in the architecture; real request rendering arrives with the
// vault and transaction milestones.

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  const requestId = params.get("id");
  if (requestId) {
    const el = document.getElementById("message");
    if (el) {
      el.textContent =
        `Approval request ${requestId} cannot be handled by this scaffold build yet. ` +
        "Approvals arrive with the wallet milestone.";
    }
  }
});

# Popup UI mockups

Static UI mockups for the Nux Connect extension popup — **HTML + CSS only,
no JavaScript, no wallet logic, demo data only**. They are visual references
for the team to implement from, not working extension code.

## Files

- `popup.html` — main popup (home) screen: TESTNET badge, balance card
  (confirmed vs unconfirmed), bech32 `tn1...` address with copy button,
  Kirim/Terima buttons, connected site, recent activity. Bold electric-green
  cartoon style.
- `vault.html` — locked vault screen: password field, unlock button,
  recovery link, 15-minute auto-lock note.
- `persetujuan.html` — transaction approval window: requesting origin on
  top, TESTNET banner, decoded transaction (destination, amount, fee,
  total out), warning, Tolak / Setujui buttons (Setujui briefly inactive,
  per spec).

## Preview

Open any file directly in a browser; no build step, no server needed.

## Notes

- UI text is in Bahasa Indonesia (target users), matching the project brief.
- Follows the locked spec: testnet-first, confirmed balance means
  >= 1 confirmation, amounts in nusan integers, fee from the active
  network endpoint (flat 1.0 nusan/vbyte).

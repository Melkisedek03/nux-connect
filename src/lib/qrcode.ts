// QR codes for the receive view: encode a plain address into a
// boolean module matrix, rendered onto a <canvas> by the popup.
// The encoder is Project Nayuki's vendored qrcodegen (MIT, dependency
// free); this module is the thin typed wrapper around it.

import { qrcodegen } from "./qrcodegen";

/** Encode `text` as a QR matrix (true = dark module), or null when the
 * text cannot be encoded. Error correction level M: plenty for a code
 * shown on screen and scanned at arm's length. */
export function encodeQrMatrix(text: string): boolean[][] | null {
  let qr: qrcodegen.QrCode;
  try {
    qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  } catch {
    return null;
  }
  const size = qr.size;
  const matrix: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      row.push(qr.getModule(x, y));
    }
    matrix.push(row);
  }
  return matrix;
}

// Connected origins: which web origins the user has approved.
//
// Stored in chrome.storage.local as a plain record mapping each origin
// (scheme + host + port, e.g. "http://localhost:3000") to the account
// addresses shared with it. An origin is present in this record only
// after the user approved a connection request from that origin in the
// approval window, and it is removed when the user disconnects it from
// the popup. The record holds public data only (origins and addresses),
// so it is safe to keep unencrypted next to the vault.

const CONNECTED_ORIGINS_KEY = "connectedOrigins";

export interface Connection {
  origin: string;
  addresses: string[];
}

function isRecord(value: unknown): value is Record<string, string[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getConnectedOrigins(): Promise<Record<string, string[]>> {
  const stored = await chrome.storage.local.get(CONNECTED_ORIGINS_KEY);
  const value = stored[CONNECTED_ORIGINS_KEY];
  return isRecord(value) ? value : {};
}

export async function isOriginConnected(origin: string): Promise<boolean> {
  const origins = await getConnectedOrigins();
  return Object.prototype.hasOwnProperty.call(origins, origin);
}

export async function listConnections(): Promise<Connection[]> {
  const origins = await getConnectedOrigins();
  return Object.entries(origins)
    .map(([origin, addresses]) => ({ origin, addresses }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/** Record (or refresh) the addresses shared with one origin. */
export async function connectOrigin(
  origin: string,
  addresses: string[],
): Promise<void> {
  const origins = await getConnectedOrigins();
  origins[origin] = addresses;
  await chrome.storage.local.set({ [CONNECTED_ORIGINS_KEY]: origins });
}

/** Remove one origin's connection. Returns true if it was connected. */
export async function disconnectOrigin(origin: string): Promise<boolean> {
  const origins = await getConnectedOrigins();
  if (!Object.prototype.hasOwnProperty.call(origins, origin)) return false;
  delete origins[origin];
  await chrome.storage.local.set({ [CONNECTED_ORIGINS_KEY]: origins });
  return true;
}

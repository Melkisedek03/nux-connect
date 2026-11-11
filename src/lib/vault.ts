// The encrypted vault and its unlock session.
//
// Locked design (see docs/):
// - On disk (chrome.storage.local) there is only an AES-GCM ciphertext.
//   The plaintext payload is the mnemonic plus a creation timestamp.
//   The encryption key is derived from the user's password with
//   PBKDF2-HMAC-SHA256, 600,000 iterations, and a random salt.
// - While unlocked, the derived key itself (never the password, never
//   the mnemonic) is held in chrome.storage.session, which is RAM-only
//   and restricted to trusted contexts (set at install time).
// - An alarm-driven check locks the vault after 15 minutes without
//   vault activity: locking means wiping the session entries.
// - Per-address private keys are never stored anywhere; they are
//   derived transiently at signing time in a later milestone.

import {
  deriveAccountPublic,
  generateMnemonicPhrase,
  isValidMnemonicPhrase,
  normalizeMnemonic,
  type AccountPublic,
} from "./keys";
import { MAINNET, TESTNET, type NuxNetwork } from "./networks";

const VAULT_RECORD_KEY = "vaultRecord";
const ACCOUNT_PUBLICS_KEY = "accountPublics";
const SESSION_KEY_KEY = "vaultSessionKey";
const SESSION_ACTIVITY_KEY = "vaultLastActivity";

export const AUTO_LOCK_MS = 15 * 60 * 1000;
const PBKDF2_ITERATIONS = 600_000;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

interface VaultRecord {
  version: 1;
  kdf: { iterations: number; salt: string }; // salt: base64
  cipher: { iv: string }; // iv: base64
  ciphertext: string; // base64
}

interface VaultPayload {
  mnemonic: string;
  createdAt: number;
}

export type AccountPublics = Record<NuxNetwork["id"], AccountPublic>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(out);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true, // extractable: the raw key is what the session stores
    ["encrypt", "decrypt"],
  );
}

async function sealPayload(
  payload: VaultPayload,
  password: string,
): Promise<{ record: VaultRecord; key: CryptoKey }> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return {
    record: {
      version: 1,
      kdf: { iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
      cipher: { iv: bytesToBase64(iv) },
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
    key,
  };
}

async function openPayload(
  record: VaultRecord,
  key: CryptoKey,
): Promise<VaultPayload> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.cipher.iv) },
      key,
      base64ToBytes(record.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as VaultPayload;
  } catch {
    // AES-GCM authentication failure: wrong key (wrong password).
    throw new VaultError("Incorrect password.");
  }
}

async function loadRecord(): Promise<VaultRecord | null> {
  const stored = await chrome.storage.local.get(VAULT_RECORD_KEY);
  const value = stored[VAULT_RECORD_KEY];
  return value ? (value as VaultRecord) : null;
}

async function startSession(key: CryptoKey): Promise<void> {
  const raw = await crypto.subtle.exportKey("raw", key);
  await chrome.storage.session.set({
    [SESSION_KEY_KEY]: bytesToBase64(new Uint8Array(raw)),
    [SESSION_ACTIVITY_KEY]: Date.now(),
  });
}

async function sessionKey(): Promise<CryptoKey | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY_KEY);
  const value = stored[SESSION_KEY_KEY];
  if (typeof value !== "string") return null;
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(value),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

export async function hasVault(): Promise<boolean> {
  return (await loadRecord()) !== null;
}

export async function isUnlocked(): Promise<boolean> {
  return (await sessionKey()) !== null;
}

export async function touchSession(): Promise<void> {
  if (await isUnlocked()) {
    await chrome.storage.session.set({
      [SESSION_ACTIVITY_KEY]: Date.now(),
    });
  }
}

/** Lock the vault: wipe the session. Returns true if it was unlocked. */
export async function lockVault(): Promise<boolean> {
  const wasUnlocked = await isUnlocked();
  await chrome.storage.session.remove([SESSION_KEY_KEY, SESSION_ACTIVITY_KEY]);
  return wasUnlocked;
}

/**
 * Alarm-driven auto-lock: locks when the last vault activity is older
 * than AUTO_LOCK_MS. Returns true when this call performed the lock.
 */
export async function checkAutoLock(): Promise<boolean> {
  const stored = await chrome.storage.session.get([
    SESSION_KEY_KEY,
    SESSION_ACTIVITY_KEY,
  ]);
  if (typeof stored[SESSION_KEY_KEY] !== "string") return false;
  const last = stored[SESSION_ACTIVITY_KEY];
  if (typeof last === "number" && Date.now() - last > AUTO_LOCK_MS) {
    await lockVault();
    return true;
  }
  return false;
}

async function storeVault(
  mnemonic: string,
  password: string,
): Promise<{ key: CryptoKey }> {
  const { record, key } = await sealPayload(
    { mnemonic: normalizeMnemonic(mnemonic), createdAt: Date.now() },
    password,
  );
  const accountPublics: AccountPublics = {
    testnet: deriveAccountPublic(mnemonic, TESTNET),
    mainnet: deriveAccountPublic(mnemonic, MAINNET),
  };
  await chrome.storage.local.set({
    [VAULT_RECORD_KEY]: record,
    [ACCOUNT_PUBLICS_KEY]: accountPublics,
  });
  await startSession(key);
  return { key };
}

/**
 * Create a brand-new vault with a generated 12-word mnemonic.
 * The mnemonic is returned exactly once, so the caller can show it to
 * the user for backup; it is never returned again afterwards.
 */
export async function createVault(
  password: string,
): Promise<{ mnemonic: string }> {
  if (await hasVault()) {
    throw new VaultError("A wallet already exists in this browser profile.");
  }
  if (!password || password.length < 8) {
    throw new VaultError("Password must be at least 8 characters.");
  }
  const mnemonic = generateMnemonicPhrase();
  await storeVault(mnemonic, password);
  return { mnemonic };
}

/** Import an existing mnemonic into a fresh vault. */
export async function importVault(
  mnemonic: string,
  password: string,
): Promise<void> {
  if (await hasVault()) {
    throw new VaultError("A wallet already exists in this browser profile.");
  }
  if (!password || password.length < 8) {
    throw new VaultError("Password must be at least 8 characters.");
  }
  if (!isValidMnemonicPhrase(mnemonic)) {
    throw new VaultError("The recovery phrase is not a valid BIP39 phrase.");
  }
  await storeVault(mnemonic, password);
}

/** Unlock an existing vault with its password. */
export async function unlockVault(password: string): Promise<void> {
  const record = await loadRecord();
  if (!record) throw new VaultError("No wallet exists yet.");
  const key = await deriveKey(
    password,
    base64ToBytes(record.kdf.salt),
    record.kdf.iterations,
  );
  await openPayload(record, key); // throws VaultError on a wrong password
  await startSession(key);
}

/**
 * Read the mnemonic using the session key. Background-internal: the
 * result is used transiently (e.g. by future signing code) and must
 * never be sent to a page or the popup after creation/import.
 */
export async function mnemonicFromSession(): Promise<string> {
  const record = await loadRecord();
  if (!record) throw new VaultError("No wallet exists yet.");
  const key = await sessionKey();
  if (!key) throw new VaultError("The wallet is locked.");
  const payload = await openPayload(record, key);
  await touchSession();
  return payload.mnemonic;
}

/** Stored public account data for both networks (no secrets). */
export async function loadAccountPublics(): Promise<AccountPublics | null> {
  const stored = await chrome.storage.local.get(ACCOUNT_PUBLICS_KEY);
  const value = stored[ACCOUNT_PUBLICS_KEY];
  return value ? (value as AccountPublics) : null;
}

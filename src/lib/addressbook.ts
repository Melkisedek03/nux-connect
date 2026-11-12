// Saved recipient addresses (Milestone 7).
//
// An entry is a label plus a public address, scoped to one network:
// the popup only ever offers entries for the active network, and an
// address is accepted only if it is valid for that network. Entries
// live in chrome.storage.local alongside the other wallet state; they
// are public data, never sent anywhere, and readable while the vault
// is locked (like the notification activity list).

import * as bitcoin from "bitcoinjs-lib";
import { toBitcoinJsNetwork } from "./keys";
import type { NuxNetwork } from "./networks";

export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
  network: NuxNetwork["id"];
  createdAt: number;
}

export const ADDRESS_BOOK_KEY = "addressBook";
export const MAX_LABEL_LENGTH = 50;

export class AddressBookError extends Error {
  readonly kind: "invalid" | "duplicate";
  constructor(message: string, kind: "invalid" | "duplicate") {
    super(message);
    this.kind = kind;
  }
}

/** True when the address parses for this network (HRP and version bytes). */
export function isValidAddressFor(address: string, network: NuxNetwork): boolean {
  try {
    bitcoin.address.toOutputScript(address, toBitcoinJsNetwork(network));
    return true;
  } catch {
    return false;
  }
}

function isAddressBookEntry(value: unknown): value is AddressBookEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.label === "string" &&
    typeof entry.address === "string" &&
    (entry.network === "mainnet" || entry.network === "testnet") &&
    typeof entry.createdAt === "number"
  );
}

export async function listAddressBookEntries(): Promise<AddressBookEntry[]> {
  const stored = await chrome.storage.local.get(ADDRESS_BOOK_KEY);
  const raw = stored[ADDRESS_BOOK_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAddressBookEntry);
}

export async function addAddressBookEntry(
  label: string,
  address: string,
  network: NuxNetwork,
): Promise<AddressBookEntry> {
  const cleanLabel = label.trim();
  if (!cleanLabel) {
    throw new AddressBookError("A label is required.", "invalid");
  }
  if (cleanLabel.length > MAX_LABEL_LENGTH) {
    throw new AddressBookError(
      `Labels are at most ${MAX_LABEL_LENGTH} characters.`,
      "invalid",
    );
  }
  const cleanAddress = address.trim();
  if (!isValidAddressFor(cleanAddress, network)) {
    throw new AddressBookError(
      "An address is not valid for this network.",
      "invalid",
    );
  }
  const entries = await listAddressBookEntries();
  if (
    entries.some(
      (entry) => entry.network === network.id && entry.address === cleanAddress,
    )
  ) {
    throw new AddressBookError(
      "This address is already in the address book.",
      "duplicate",
    );
  }
  const entry: AddressBookEntry = {
    id: crypto.randomUUID(),
    label: cleanLabel,
    address: cleanAddress,
    network: network.id,
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({
    [ADDRESS_BOOK_KEY]: [...entries, entry],
  });
  return entry;
}

export async function removeAddressBookEntry(id: string): Promise<boolean> {
  const entries = await listAddressBookEntries();
  const kept = entries.filter((entry) => entry.id !== id);
  if (kept.length === entries.length) return false;
  await chrome.storage.local.set({ [ADDRESS_BOOK_KEY]: kept });
  return true;
}

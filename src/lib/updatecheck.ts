// New-version notice (Milestone 14).
//
// The extension is sideloaded (Load unpacked / Temporary Add-on),
// so the browser never updates it on its own — only store
// distribution auto-updates. This module checks the latest GitHub
// release instead, and the popup shows a banner with a link to the
// release page; the user still downloads and reloads manually.
//
// Source of truth: the public GitHub Releases API (no auth). The
// result is cached for 24 hours in chrome.storage.local. The check
// fails open: any fetch failure, offline state, or malformed
// response yields "no update known" — no banner, no throw, no
// user-visible error — and the previous cache is kept.
// The release link is validated to github.com only; nothing is
// ever downloaded or executed from this check.

export interface UpdateStatus {
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
}

interface UpdateCheckCache {
  latestVersion: string;
  releaseUrl: string;
  checkedAt: number;
}

export const UPDATE_CHECK_CACHE_KEY = "updateCheckCache";
export const DISMISSED_UPDATE_KEY = "dismissedUpdateVersion";

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/TaobotX11/nux-connect/releases/latest";
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Compare two "x.y.z" versions: negative when a < b, 0 when equal,
 * positive when a > b. Missing or non-numeric parts count as 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10));
  const pb = b.split(".").map((p) => Number.parseInt(p, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const y = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Parse a latest-release response into { version, url }, or null
 * on any unrecognized shape. The tag's leading "v" is stripped and
 * the remainder must be a plain x.y.z; the link must be exactly
 * github.com — anything else is rejected.
 */
export function parseLatestRelease(
  json: unknown,
): { version: string; url: string } | null {
  if (typeof json !== "object" || json === null) return null;
  const data = json as Record<string, unknown>;
  const tag = data["tag_name"];
  const htmlUrl = data["html_url"];
  if (typeof tag !== "string" || typeof htmlUrl !== "string") return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  let host: string;
  try {
    host = new URL(htmlUrl).hostname;
  } catch {
    return null;
  }
  if (host !== "github.com") return null;
  return { version, url: htmlUrl };
}

async function fetchLatestRelease(): Promise<{
  version: string;
  url: string;
} | null> {
  try {
    // AbortSignal.timeout: a single expression, no timer to clear —
    // and no setTimeout call, so this check never disturbs the
    // retry-timing surface the electrs client measures.
    const response = await fetch(LATEST_RELEASE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseLatestRelease((await response.json()) as unknown);
  } catch {
    return null;
  }
}

async function readCache(): Promise<UpdateCheckCache | null> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_CHECK_CACHE_KEY);
    const cached = stored[UPDATE_CHECK_CACHE_KEY] as
      | UpdateCheckCache
      | undefined;
    if (
      !cached ||
      typeof cached.latestVersion !== "string" ||
      typeof cached.releaseUrl !== "string" ||
      typeof cached.checkedAt !== "number"
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

async function writeCache(record: UpdateCheckCache): Promise<void> {
  try {
    await chrome.storage.local.set({ [UPDATE_CHECK_CACHE_KEY]: record });
  } catch {
    // A failed cache write must not fail the check.
  }
}

/** The version the user dismissed, if any. */
export async function readDismissedVersion(): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(DISMISSED_UPDATE_KEY);
    const value = stored[DISMISSED_UPDATE_KEY];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Dismiss the banner for one version. The dismiss is per-version:
 * dismissing 0.15.0 hides only 0.15.0 — a newer version later
 * still shows its banner.
 */
export async function dismissUpdateVersion(version: string): Promise<void> {
  await chrome.storage.local.set({ [DISMISSED_UPDATE_KEY]: version });
}

/**
 * Check for a newer release. Never throws: any failure yields
 * "no update known" and the previous cache is kept — a failed
 * fetch still serves the last known record, so a transient outage
 * does not blank a banner the user has already seen.
 * The dismissed version is applied by the caller (the background
 * folds it into the status), so a dismissed version never shows
 * again while a newer one still does.
 */
export async function getUpdateStatus(
  currentVersion: string,
): Promise<UpdateStatus> {
  const noUpdate: UpdateStatus = {
    updateAvailable: false,
    latestVersion: null,
    releaseUrl: null,
  };
  try {
    const cached = await readCache();
    const fresh =
      cached !== null && Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS;
    let latest: { version: string; url: string } | null = fresh
      ? { version: cached.latestVersion, url: cached.releaseUrl }
      : null;
    if (!fresh) {
      const fetched = await fetchLatestRelease();
      if (fetched) {
        latest = fetched;
        await writeCache({
          latestVersion: fetched.version,
          releaseUrl: fetched.url,
          checkedAt: Date.now(),
        });
      } else if (cached) {
        latest = { version: cached.latestVersion, url: cached.releaseUrl };
      }
    }
    if (!latest) return noUpdate;
    if (compareVersions(latest.version, currentVersion) <= 0) return noUpdate;
    return {
      updateAvailable: true,
      latestVersion: latest.version,
      releaseUrl: latest.url,
    };
  } catch {
    return noUpdate;
  }
}

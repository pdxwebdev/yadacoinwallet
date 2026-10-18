/**
 * useCredentialStatus.js
 *
 * Credential status / revocation checking for W3C VC 2.0.
 *
 * Supports two status list formats:
 *
 * 1. BitstringStatusList (W3C 2024, preferred)
 *    credentialStatus: {
 *      type: "BitstringStatusListEntry",
 *      statusListIndex: "42",
 *      statusListCredential: "https://example.com/status/1",
 *      statusPurpose: "revocation" | "suspension"
 *    }
 *
 * 2. StatusList2021 (older widely-deployed format)
 *    credentialStatus: {
 *      type: "StatusList2021Entry",
 *      statusListIndex: "42",
 *      statusListCredential: "https://example.com/status/1",
 *      statusPurpose: "revocation" | "suspension"
 *    }
 *
 * Both formats use the same on-wire encoding:
 *   - The statusListCredential URL resolves to a VC whose credentialSubject
 *     contains an "encodedList" — a GZIP-compressed bitstring encoded as
 *     base64url (BitstringStatusList) or base64 (StatusList2021).
 *   - Bit at statusListIndex == 1 means the credential is revoked/suspended.
 *
 * Results are cached in memory (keyed by statusListCredential URL) for the
 * session lifetime. The cache TTL is 5 minutes; after that, the next check
 * re-fetches. This avoids hammering the issuer on every render while still
 * catching status changes within a reasonable window.
 *
 * Privacy note: fetching the status list URL contacts the issuer's server.
 * BitstringStatusList is designed so that the issuer cannot correlate which
 * credential is being checked (the full list is fetched, not a per-credential
 * endpoint). The index lookup is done entirely client-side.
 */

// ── Status result shape ───────────────────────────────────────────────────────
// { status: "valid" | "revoked" | "suspended" | "unknown" | "error",
//   message: string, checkedAt: number }

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache: URL → { bits: Uint8Array, fetchedAt: number }
const _listCache = new Map();

// Per-credential status cache: vc.id → result
const _statusCache = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check the revocation / suspension status of a single VC.
 *
 * Returns a status result object:
 *   { status, message, checkedAt }
 *
 * Status values:
 *   "valid"     — credential is not revoked or suspended
 *   "revoked"   — credential has been revoked
 *   "suspended" — credential has been suspended
 *   "unknown"   — no credentialStatus field present (cannot check)
 *   "error"     — network or parse error during check
 *   "checking"  — placeholder while async check is in progress (not returned here)
 */
export async function checkCredentialStatus(vc) {
  const cached = _statusCache.get(vc.id);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached;
  }

  const result = await _doCheck(vc);
  if (vc.id) _statusCache.set(vc.id, result);
  return result;
}

/**
 * Check status for multiple VCs in parallel.
 * Returns a Map<vcId, statusResult>.
 */
export async function checkAllCredentialStatuses(vcs) {
  const results = await Promise.allSettled(
    vcs.map((vc) => checkCredentialStatus(vc)),
  );
  const map = new Map();
  vcs.forEach((vc, i) => {
    const r = results[i];
    map.set(
      vc.id,
      r.status === "fulfilled"
        ? r.value
        : {
            status: "error",
            message: r.reason?.message || "Check failed",
            checkedAt: Date.now(),
          },
    );
  });
  return map;
}

/**
 * Invalidate cached status for a specific credential (force re-check).
 */
export function invalidateStatus(vcId) {
  _statusCache.delete(vcId);
}

/**
 * Clear all cached status lists (e.g., on app resume / foreground).
 */
export function clearStatusListCache() {
  _listCache.clear();
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _doCheck(vc) {
  const now = Date.now();

  // Check expiry first (no network needed)
  const expiry = vc.expirationDate || vc.validUntil;
  if (expiry && new Date(expiry).getTime() < now) {
    return {
      status: "revoked",
      message: `Credential expired on ${new Date(expiry).toLocaleDateString()}`,
      checkedAt: now,
    };
  }

  const statusEntry = _getStatusEntry(vc);
  if (!statusEntry) {
    return {
      status: "unknown",
      message: "No status entry in credential",
      checkedAt: now,
    };
  }

  const { type, statusListCredential, statusListIndex, statusPurpose } =
    statusEntry;

  if (!statusListCredential || statusListIndex == null) {
    return {
      status: "unknown",
      message: "Incomplete credentialStatus field",
      checkedAt: now,
    };
  }

  const index = parseInt(statusListIndex, 10);
  if (isNaN(index) || index < 0) {
    return {
      status: "error",
      message: `Invalid statusListIndex: ${statusListIndex}`,
      checkedAt: now,
    };
  }

  const isBitstring = type === "BitstringStatusListEntry";
  const isStatusList2021 = type === "StatusList2021Entry";

  if (!isBitstring && !isStatusList2021) {
    return {
      status: "unknown",
      message: `Unsupported status type: ${type}`,
      checkedAt: now,
    };
  }

  let bits;
  try {
    bits = await _fetchStatusList(statusListCredential, isBitstring);
  } catch (e) {
    return {
      status: "error",
      message: `Status list fetch failed: ${e.message}`,
      checkedAt: now,
    };
  }

  const isSet = _getBit(bits, index);
  const purpose = statusPurpose || "revocation";

  if (isSet) {
    const status = purpose === "suspension" ? "suspended" : "revoked";
    return {
      status,
      message: `Credential ${status} by issuer`,
      checkedAt: now,
    };
  }

  return { status: "valid", message: "Credential is valid", checkedAt: now };
}

/**
 * Extract the first credentialStatus entry of a supported type.
 * credentialStatus may be a single object or an array.
 */
function _getStatusEntry(vc) {
  const cs = vc.credentialStatus;
  if (!cs) return null;
  const entries = Array.isArray(cs) ? cs : [cs];
  const supported = ["BitstringStatusListEntry", "StatusList2021Entry"];
  return entries.find((e) => supported.includes(e.type)) || null;
}

/**
 * Fetch and decode a status list, returning a Uint8Array of bits.
 * Uses in-memory cache with TTL.
 */
async function _fetchStatusList(url, isBitstring) {
  const cached = _listCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.bits;
  }

  const resp = await fetch(url, {
    headers: { Accept: "application/json, application/vc+ld+json" },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  let statusListVc;

  if (
    contentType.includes("application/json") ||
    contentType.includes("ld+json")
  ) {
    statusListVc = await resp.json();
  } else {
    // May be a JWT-encoded VC
    const text = await resp.text();
    statusListVc = _decodeJwtPayload(text);
  }

  // Extract encodedList from credentialSubject
  const subject =
    statusListVc?.credentialSubject || statusListVc?.vc?.credentialSubject;
  const encodedList = subject?.encodedList;

  if (!encodedList) {
    throw new Error("Status list VC missing encodedList in credentialSubject");
  }

  const bits = await _decodeStatusList(encodedList, isBitstring);
  _listCache.set(url, { bits, fetchedAt: Date.now() });
  return bits;
}

/**
 * Decode the base64url (BitstringStatusList) or base64 (StatusList2021)
 * encodedList into a Uint8Array of decompressed bits.
 *
 * The spec mandates GZIP compression. We decompress using DecompressionStream
 * (available in all modern browsers and Node 18+).
 */
async function _decodeStatusList(encodedList, isBitstring) {
  // BitstringStatusList uses base64url; StatusList2021 uses standard base64
  let b64;
  if (isBitstring) {
    b64 = encodedList.replace(/-/g, "+").replace(/_/g, "/");
    // Pad to multiple of 4
    const pad = (4 - (b64.length % 4)) % 4;
    b64 += "=".repeat(pad);
  } else {
    b64 = encodedList;
  }

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Decompress GZIP
  const decompressed = await _gunzip(bytes);
  return decompressed;
}

async function _gunzip(compressed) {
  if (typeof DecompressionStream !== "undefined") {
    // Modern browser / Node 18+
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(compressed);
    writer.close();

    const chunks = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (value) chunks.push(value);
      done = d;
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // Fallback: try pako if available (some older environments)
  if (typeof window !== "undefined" && window.pako?.inflate) {
    return window.pako.inflate(compressed);
  }

  throw new Error(
    "GZIP decompression not available. " +
      "Browser must support DecompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+).",
  );
}

/**
 * Get the bit value at a given index in a packed bitstring.
 * The bitstring is big-endian: byte 0 holds bits 0-7 (MSB first).
 */
function _getBit(bits, index) {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = 7 - (index % 8); // MSB-first within each byte
  if (byteIndex >= bits.length) return false;
  return ((bits[byteIndex] >> bitIndex) & 1) === 1;
}

/**
 * Decode the payload of a compact JWT without verifying the signature.
 * Used to read the status list VC when it's served as a JWT.
 */
function _decodeJwtPayload(jwt) {
  const parts = jwt.trim().split(".");
  if (parts.length < 2) throw new Error("Not a valid JWT");
  const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return JSON.parse(atob(padded + "=".repeat(pad)));
}

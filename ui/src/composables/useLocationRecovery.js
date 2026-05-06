/**
 * useLocationRecovery.js
 *
 * Location-based wallet creation and recovery.
 *
 * Design:
 *   - User picks 8 locations on a map (quantized to 4dp ≈ 11m resolution)
 *   - PBKDF2(locations_string, fixed_app_salt) → 128-bit entropy → 12-word BIP39 mnemonic
 *   - The wallet IS the locations — nothing secret is stored anywhere
 *   - A short Recovery Code is generated as a server-side lookup key for hints
 *   - Server stores ONLY: {code, hints[8]} — NO salt, NO iv, NO ciphertext
 *
 * Recovery on any device:
 *   - Enter Recovery Code → fetch hint labels from server
 *   - Re-pin the 8 locations on the map
 *   - Same locations → same mnemonic → same wallet
 *   - Set a new PIN to protect the local vault
 */

import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export const LOCATION_COUNT = 8;

// Fixed application salt — public, not secret.
// Changing this would break all existing wallets.
const APP_SALT = new TextEncoder().encode("yadacoin-career-wallet-location-v1");

// ── Recovery code generation ──────────────────────────────────────────────────
// Crockford Base32 alphabet (avoids 0/O, 1/I/L confusion)
const B32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes).map((b) => B32[b % 32]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeCode(code) {
  return code.replace(/[-\s]/g, "").toUpperCase();
}

// ── Quantization ──────────────────────────────────────────────────────────────
function quantize(coord) {
  return Math.round(coord * 10000) / 10000;
}

function encodeLocations(locations) {
  return locations
    .map(
      (loc) =>
        `${quantize(loc.lat).toFixed(4)},${quantize(loc.lng).toFixed(4)}`,
    )
    .join("|");
}

// ── Deterministic derivation ──────────────────────────────────────────────────
/**
 * Derive a 12-word BIP39 mnemonic deterministically from 8 locations.
 * Same locations on any device → same mnemonic → same wallet.
 */
async function deriveFromLocations(locations) {
  const locationString = encodeLocations(locations);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(locationString),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: APP_SALT, iterations: 310_000, hash: "SHA-256" },
    keyMaterial,
    128, // 128 bits → 12-word mnemonic
  );
  return bip39.entropyToMnemonic(new Uint8Array(bits), wordlist);
}

// ── Server helpers (hints only — no crypto material) ─────────────────────────
async function serverSaveHints(code, hints) {
  const res = await fetch("/wallet/api/location-hints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalizeCode(code), hints }),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
}

async function serverFetchHints(code) {
  const res = await fetch(
    `/wallet/api/location-hints?code=${encodeURIComponent(normalizeCode(code))}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return data.hints ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive a wallet from locations and save hint labels to the server.
 *
 * @param {Array}  locations - 8 {lat, lng, hint} objects
 * @returns {{ mnemonic: string, code: string }}
 *   mnemonic — derived BIP39 phrase (pass to vault.importMnemonic)
 *   code     — Recovery Code to show the user (e.g. "7KMN-2QPR")
 */
export async function setupLocationRecovery(locations) {
  if (locations.length !== LOCATION_COUNT) {
    throw new Error(`Exactly ${LOCATION_COUNT} locations required`);
  }
  const mnemonic = await deriveFromLocations(locations);
  const code = generateRecoveryCode();
  await serverSaveHints(
    code,
    locations.map((l) => l.hint || ""),
  );
  return { mnemonic, code };
}

/**
 * Fetch the hint labels for a Recovery Code (shown during recovery to help
 * the user remember where to place each pin).
 * Returns null if the code is not found.
 */
export async function getLocationHints(code) {
  return serverFetchHints(code);
}

/**
 * Re-derive the wallet mnemonic from locations on any device.
 * No server call needed — the mnemonic is deterministic from the locations alone.
 *
 * @param {Array} locations - 8 {lat, lng} objects (re-entered by user)
 * @returns {string} BIP39 mnemonic
 */
export async function recoverWithLocations(locations) {
  if (locations.length !== LOCATION_COUNT) {
    throw new Error(`Exactly ${LOCATION_COUNT} locations required`);
  }
  return deriveFromLocations(locations);
}

/**
 * useLocationRecovery.js — ZKP location commitment edition
 *
 * Three locations generate a witness whose commitment is embedded in a
 * blockchain transaction. Recovery re-derives the witness and verifies the
 * proof to decrypt the mnemonic.
 *
 * Cryptographic structure:
 *   Witness:    w  = HKDF(locations, salt, "zkp-witness")     — private, never stored
 *   Scalar:     x  = w as big-endian scalar (mod N)
 *   EC commit:  C  = x·G                                      — published only at recovery
 *   WitnessHash:H  = SHA-256(C_compressed_bytes)              — published in {"recovery": H}
 *                                                               announcement; binds the
 *                                                               commitment ahead of time
 *   EncKey:     k  = HKDF(w, salt, "mnemonic-enc")            — AES-256-GCM key (domain-separated)
 *   Proof:      Schnorr(x, prevKeyHash) via Fiat-Shamir       — no trusted setup
 *     e = SHA-256(R ‖ C ‖ prevKeyHash_or_zeros)
 *     s = r − e·x  mod N
 *   Verify:     SHA-256(C_compressed) == witnessHash
 *               s·G + e·C == R
 *
 * On-chain flow:
 *   1. Announce  : tx.relationship = {"recovery": witnessHash}    (KEL unconfirmed entry)
 *   2. Recover   : new KEL inception with prev_public_key_hash set and
 *                  tx.relationship = {"recovers": {commitment, R, s}}
 *
 *   prevKeyHash binds the proof to a specific key log entry, so a recovery
 *   proof for one KEL cannot be replayed against another.
 */

import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export const LOCATION_COUNT = 3;

// secp256k1 group order — well-known public constant
const CURVE_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ── Byte / bigint helpers ─────────────────────────────────────────────────────

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes32(n) {
  return hexToBytes(n.toString(16).padStart(64, "0"));
}

// ── Location encoding ─────────────────────────────────────────────────────────

const PRECISION = 4;

function quantize(coord) {
  return Math.round(coord * 10_000) / 10_000;
}

function encodeLocations(locations) {
  return locations
    .map(
      (l) =>
        `${quantize(l.lat).toFixed(PRECISION)},${quantize(l.lng).toFixed(PRECISION)}`,
    )
    .join("|");
}

// ── Witness derivation (HKDF) ─────────────────────────────────────────────────

const APP_SALT = new TextEncoder().encode("yadacoin-location-zkp-v1");
const WITNESS_INFO = new TextEncoder().encode("zkp-witness");
const ENC_INFO = new TextEncoder().encode("mnemonic-enc");

/** Returns a 32-byte Uint8Array witness — NEVER stored, only held in memory */
function deriveWitness(locations) {
  const ikm = new TextEncoder().encode(encodeLocations(locations));
  return hkdf(sha256, ikm, APP_SALT, WITNESS_INFO, 32);
}

/** Derive AES encryption key from witness (domain-separated) */
function deriveEncKey(witnessBytes) {
  return hkdf(sha256, witnessBytes, APP_SALT, ENC_INFO, 32);
}

function witnessToScalar(witnessBytes) {
  return (bytesToBigInt(witnessBytes) % (CURVE_N - 1n)) + 1n;
}

// ── AES-256-GCM encryption of mnemonic ───────────────────────────────────────

async function encryptMnemonic(encKeyBytes, mnemonic) {
  const key = await crypto.subtle.importKey(
    "raw",
    encKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(mnemonic),
  );
  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

async function decryptMnemonic(encKeyBytes, encryptedMnemonic) {
  const key = await crypto.subtle.importKey(
    "raw",
    encKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(encryptedMnemonic.iv) },
    key,
    new Uint8Array(encryptedMnemonic.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

// ── Schnorr ZKP (non-interactive via Fiat-Shamir, no trusted setup) ───────────
//
//   Private: x (witness scalar)
//   Public:  C = x·G,  witnessHash = SHA-256(witness bytes)
//
//   Prove:   r ← random, R = r·G
//            e = SHA-256(R ‖ C ‖ prevKeyHash_or_zeros)   [Fiat-Shamir]
//            s = r − e·x  mod N
//   Verify:  e = SHA-256(R ‖ C ‖ prevKeyHash_or_zeros),  s·G + e·C == R
//
//   prevKeyHash binds the proof to a specific key log entry, preventing replay.

function buildChallenge(R_hex, commitment, prevKeyHash) {
  // prevKeyHash is the previous KEL tip's public_key_hash, which on YadaCoin
  // is a base58 P2PKH address string — not hex.  We hash its raw UTF-8 bytes
  // so the Python verifier in yadacoin/core/locationrecovery.py can reproduce
  // the same digest without parsing the address codec.  When absent a 32-byte
  // zero block is substituted (used during local-only setup before the proof
  // has been bound to a key log entry).
  const prevBytes = prevKeyHash
    ? new TextEncoder().encode(prevKeyHash)
    : new Uint8Array(32);
  return new Uint8Array([
    ...hexToBytes(R_hex),
    ...hexToBytes(commitment),
    ...prevBytes,
  ]);
}

/**
 * Generate a Schnorr proof of knowledge of the witness scalar.
 *
 * @param {bigint} x            - witness scalar (private)
 * @param {string|null} prevKeyHash - hex hash of prev key log entry (public input)
 * @returns {{ commitment, R, s }}
 */
function generateProof(x, prevKeyHash = null) {
  const G = secp.Point.BASE;
  const C = G.multiply(x);

  const rBytes = crypto.getRandomValues(new Uint8Array(32));
  const r = (bytesToBigInt(rBytes) % (CURVE_N - 1n)) + 1n;
  const R = G.multiply(r);

  const e =
    bytesToBigInt(
      sha256(buildChallenge(R.toHex(true), C.toHex(true), prevKeyHash)),
    ) % CURVE_N;

  const s = (((r - e * x) % CURVE_N) + CURVE_N) % CURVE_N;

  return {
    commitment: C.toHex(true),
    R: R.toHex(true),
    s: bytesToHex(bigIntToBytes32(s)),
  };
}

/**
 * Verify a Schnorr proof.
 *
 * @param {string} commitment   - EC commitment C hex
 * @param {string} R_hex        - R = r·G hex
 * @param {string} s_hex        - response scalar hex
 * @param {string|null} prevKeyHash - same prevKeyHash used during generation
 */
function verifyProof(commitment, R_hex, s_hex, prevKeyHash = null) {
  try {
    const G = secp.Point.BASE;
    const C = secp.Point.fromHex(commitment);
    const R = secp.Point.fromHex(R_hex);
    const e =
      bytesToBigInt(sha256(buildChallenge(R_hex, commitment, prevKeyHash))) %
      CURVE_N;
    const s = bytesToBigInt(hexToBytes(s_hex));
    if (s === 0n || s >= CURVE_N) return false;
    return G.multiply(s).add(C.multiply(e)).equals(R);
  } catch {
    return false;
  }
}

// ── IndexedDB storage ─────────────────────────────────────────────────────────

const DB_NAME = "yadacoin_wallet";
const DB_VERSION = 1;
const VAULT_STORE = "vault";
const LOCATION_VAULT_KEY = "location_recovery_vault";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(VAULT_STORE);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveLocationVault(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    const req = tx.objectStore(VAULT_STORE).put(data, LOCATION_VAULT_KEY);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadLocationVault() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readonly");
    const req = tx.objectStore(VAULT_STORE).get(LOCATION_VAULT_KEY);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ── Recovery code (server-side hints only) ────────────────────────────────────

const B32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => B32[b % 32]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeCode(code) {
  return code.replace(/[-\s]/g, "").toUpperCase();
}

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
 * Set up location-based recovery.
 *
 * Derives a witness from 3 locations, generates a Schnorr ZKP commitment,
 * encrypts the mnemonic, and stores everything locally (pending blockchain
 * integration). Returns txnData containing all fields for the blockchain txn.
 *
 * @param {Array}       locations        - 3 {lat, lng, hint} objects
 * @param {string|null} existingMnemonic - existing mnemonic to protect; if null
 *                                         a fresh random BIP-39 phrase is generated
 * @param {string|null} prevKeyHash      - hex hash of the latest key log entry
 *                                         (public input that binds proof to key log)
 * @returns {{ mnemonic, code, txnData }}
 */
export async function setupLocationRecovery(
  locations,
  existingMnemonic = null,
  prevKeyHash = null,
) {
  if (locations.length !== LOCATION_COUNT)
    throw new Error(`Exactly ${LOCATION_COUNT} locations required`);

  // Derive witness (private)
  const witness = deriveWitness(locations);

  // EC scalar and Schnorr proof (prevKeyHash bound into challenge)
  const x = witnessToScalar(witness);
  const proof = generateProof(x, prevKeyHash);

  // witnessHash commits to the EC commitment itself — published in the
  // "recovery" announcement so the chain can later verify that the proof's
  // commitment matches what was announced.
  const witnessHash = bytesToHex(sha256(hexToBytes(proof.commitment)));

  // Domain-separated encryption key (never equals the EC scalar)
  const encKey = deriveEncKey(witness);
  const mnemonic = existingMnemonic ?? bip39.generateMnemonic(wordlist, 128);
  const encryptedMnemonic = await encryptMnemonic(encKey, mnemonic);

  // Store locally (blockchain txn will eventually be the authoritative source)
  await saveLocationVault({
    commitment: proof.commitment,
    proof: { R: proof.R, s: proof.s },
    prevKeyHash: prevKeyHash ?? null,
    encryptedMnemonic,
  });

  const code = generateRecoveryCode();
  await serverSaveHints(
    code,
    locations.map((l) => l.hint || ""),
  );

  // The on-chain flow uses two transactions:
  //   1. announcementData — unconfirmed entry committing to witnessHash
  //   2. recoveryData     — new-KEL inception revealing the proof
  const txnData = {
    announcementData: {
      // Goes in the announcement tx's relationship field
      relationship: { recovery: witnessHash },
    },
    recoveryData: {
      // Goes in the new-KEL inception tx's relationship field; chain reads
      // prev_public_key_hash from the tx itself (set to the previous KEL
      // tip's public_key_hash) and binds it into the Fiat-Shamir challenge.
      relationship: {
        recovers: { commitment: proof.commitment, R: proof.R, s: proof.s },
      },
    },
    // Convenience: AES-GCM encrypted mnemonic (also stored locally; the chain
    // doesn't need it but a backup carrier might).
    encryptedMnemonic,
    // Audit / debug fields
    witnessHash,
    prevKeyHash: prevKeyHash ?? null,
  };

  return { mnemonic, code, txnData };
}

/**
 * Recover the wallet mnemonic by re-entering 3 locations.
 *
 * 1. Re-derives the witness from locations.
 * 2. Verifies witnessHash matches the stored commitment (fast preimage check).
 * 3. Verifies the Schnorr ZKP against the stored EC commitment.
 * 4. Decrypts and returns the mnemonic.
 *
 * @param {Array} locations - 3 {lat, lng} objects
 * @returns {string} BIP-39 mnemonic
 */
export async function recoverWithLocations(locations) {
  if (locations.length !== LOCATION_COUNT)
    throw new Error(`Exactly ${LOCATION_COUNT} locations required`);

  const stored = await loadLocationVault();
  if (!stored)
    throw new Error(
      "No location recovery found on this device. Set up location recovery first.",
    );

  // Re-derive witness and recompute the EC commitment
  const witness = deriveWitness(locations);
  const x = witnessToScalar(witness);
  const G = secp.Point.BASE;
  const recomputedCommitment = G.multiply(x).toHex(true);

  // 1. Fast preimage check — commitment must match what was stored
  if (recomputedCommitment !== stored.commitment)
    throw new Error("Incorrect locations — please try again.");

  // 2. Verify Schnorr ZKP (using the prevKeyHash from the original setup)
  const valid = verifyProof(
    stored.commitment,
    stored.proof.R,
    stored.proof.s,
    stored.prevKeyHash ?? null,
  );
  if (!valid) throw new Error("Zero-knowledge proof verification failed.");

  // 3. Decrypt mnemonic
  const encKey = deriveEncKey(witness);
  return decryptMnemonic(encKey, stored.encryptedMnemonic);
}

/**
 * Fetch hint labels from the server for a recovery code.
 * Returns null if the code is not found.
 */
export async function getLocationHints(code) {
  return serverFetchHints(code);
}

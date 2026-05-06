/**
 * useKeyVault.js
 *
 * Holder key management:
 *   - BIP39 mnemonic generated in-browser
 *   - BIP32 secp256k1 key derivation (m/44'/0'/0'/0/index)
 *   - Vault encrypted with WebCrypto AES-256-GCM using a PIN-derived key
 *   - Encrypted vault stored in IndexedDB (never sent to server)
 *   - Device-bound ECDH key (non-extractable) optionally wraps the PIN key
 *     for convenience unlock (biometric / device auth gate in future)
 *
 * Key hierarchy:
 *   mnemonic → seed → xprv (BIP32 root)
 *     m/44'/0'/0'/0/0  ← current signing key (DID key)
 *     m/44'/0'/0'/0/1  ← pre-rotated key (committed in KEL)
 *     m/44'/0'/0'/0/N  ← next keys on rotation
 */

import { ref, readonly } from "vue";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

// ── Constants ────────────────────────────────────────────────────────────────
const DB_NAME = "yadacoin_wallet";
const DB_VERSION = 1;
const VAULT_STORE = "vault";
const VAULT_KEY = "holder_vault";
const META_KEY = "wallet_meta"; // plaintext {did} — safe to store unencrypted
const DERIVATION_PATH_PREFIX = "m/44'/0'/0'/0/";

// ── State ────────────────────────────────────────────────────────────────────
const isUnlocked = ref(false);
const holderDid = ref(null);
const currentKeyIndex = ref(0);

let _hdRoot = null; // HDKey instance, only in memory while unlocked

// ── Platform detection ────────────────────────────────────────────────────────
function isNative() {
  return (
    typeof window !== "undefined" &&
    window.Capacitor != null &&
    window.Capacitor.isNativePlatform()
  );
}

// ── Native secure storage (Capacitor) ────────────────────────────────────────
async function nativeGet(key) {
  const { SecureStoragePlugin } =
    await import("capacitor-secure-storage-plugin");
  try {
    const { value } = await SecureStoragePlugin.get({ key });
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined; // key not found
  }
}

async function nativePut(key, value) {
  const { SecureStoragePlugin } =
    await import("capacitor-secure-storage-plugin");
  await SecureStoragePlugin.set({ key, value: JSON.stringify(value) });
}

async function nativeDelete(key) {
  const { SecureStoragePlugin } =
    await import("capacitor-secure-storage-plugin");
  try {
    await SecureStoragePlugin.remove({ key });
  } catch {
    // ignore if not found
  }
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
// ── IndexedDB helpers ─────────────────────────────────────────────────────────
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

async function dbGet(key) {
  if (isNative()) return nativeGet(key);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readonly");
    const req = tx.objectStore(VAULT_STORE).get(key);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPut(key, value) {
  if (isNative()) return nativePut(key, value);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    const req = tx.objectStore(VAULT_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbDelete(key) {
  if (isNative()) return nativeDelete(key);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    const req = tx.objectStore(VAULT_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// ── WebCrypto helpers ─────────────────────────────────────────────────────────
/**
 * Derive an AES-256-GCM key from a PIN using PBKDF2.
 * salt is a Uint8Array (stored in vault alongside ciphertext).
 */
async function deriveAesKey(pin, salt) {
  const pinBytes = new TextEncoder().encode(pin);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    pinBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 310_000, // OWASP 2023 recommendation for PBKDF2-SHA256
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptVault(plaintext, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(pin, salt);
  const data = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    data,
  );
  return {
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

async function decryptVault(encrypted, pin) {
  const salt = new Uint8Array(encrypted.salt);
  const iv = new Uint8Array(encrypted.iv);
  const ciphertext = new Uint8Array(encrypted.ciphertext);
  const aesKey = await deriveAesKey(pin, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Key derivation helpers ────────────────────────────────────────────────────
function deriveChildKey(hdRoot, index) {
  return hdRoot.derive(`${DERIVATION_PATH_PREFIX}${index}`);
}

// ── Browser-safe hex helpers ─────────────────────────────────────────────────
function hexEncode(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexDecode(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function publicKeyHex(hdChild) {
  return hexEncode(hdChild.publicKey);
}

function didFromPublicKey(pubKeyHex) {
  // did:key using multibase base58btc of compressed secp256k1 pubkey
  // Multicodec prefix for secp256k1: 0xe7 0x01
  const pubBytes = hexDecode(pubKeyHex);
  const prefixed = new Uint8Array([0xe7, 0x01, ...pubBytes]);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/** Minimal base58btc encoder (alphabet matches multibase) */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btcEncode(bytes) {
  let num = BigInt("0x" + hexEncode(bytes));
  let result = "";
  const base = BigInt(58);
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % base)] + result;
    num = num / base;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result = "1" + result;
  }
  return result;
}

function hashPublicKey(pubKeyHex) {
  const bytes = hexDecode(pubKeyHex);
  return hexEncode(sha256(bytes));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true if an encrypted vault exists in IndexedDB */
async function hasVault() {
  const v = await dbGet(VAULT_KEY);
  return !!v;
}

/**
 * Create a new wallet from a freshly generated mnemonic.
 * Returns the mnemonic — caller must show it to the user for backup.
 * The vault is encrypted with PIN and stored in IndexedDB.
 */
async function createWallet(pin) {
  const mnemonic = bip39.generateMnemonic(wordlist, 128); // 12 words
  await importMnemonic(mnemonic, pin);
  return mnemonic;
}

/**
 * Import an existing mnemonic (recovery flow).
 * Encrypts and stores the vault.
 */
async function importMnemonic(mnemonic, pin) {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const hdRoot = HDKey.fromMasterSeed(seed);
  const currentChild = deriveChildKey(hdRoot, 0);
  const nextChild = deriveChildKey(hdRoot, 1);
  const currentPubHex = publicKeyHex(currentChild);
  const nextPubHex = publicKeyHex(nextChild);

  const vaultData = {
    mnemonic,
    keyIndex: 0,
    currentPublicKey: currentPubHex,
    nextKeyHash: hashPublicKey(nextPubHex), // pre-rotation commitment
    did: didFromPublicKey(currentPubHex),
  };

  const encrypted = await encryptVault(vaultData, pin);
  await dbPut(VAULT_KEY, encrypted);
  await dbPut(META_KEY, { did: vaultData.did });

  _hdRoot = hdRoot;
  currentKeyIndex.value = 0;
  holderDid.value = vaultData.did;
  isUnlocked.value = true;
}

/**
 * Unlock the wallet with PIN. Throws if PIN is wrong (AES-GCM auth tag fails).
 */
async function unlock(pin) {
  const encrypted = await dbGet(VAULT_KEY);
  if (!encrypted) throw new Error("No wallet found. Please create one first.");
  const vaultData = await decryptVault(encrypted, pin);
  const seed = await bip39.mnemonicToSeed(vaultData.mnemonic);
  _hdRoot = HDKey.fromMasterSeed(seed);
  currentKeyIndex.value = vaultData.keyIndex;
  holderDid.value = vaultData.did;
  isUnlocked.value = true;
}

/** Lock the wallet — clears in-memory key material */
function lock() {
  _hdRoot = null;
  isUnlocked.value = false;
  holderDid.value = null;
}

/**
 * Sign arbitrary bytes with the current holder key.
 * Returns DER-encoded signature as hex string.
 */
async function sign(messageBytes) {
  if (!_hdRoot) throw new Error("Wallet locked");
  const child = deriveChildKey(_hdRoot, currentKeyIndex.value);
  const privKey = child.privateKey;
  const sig = await secp.signAsync(sha256(messageBytes), privKey);
  return hexEncode(sig.toDERRawBytes());
}

/**
 * Return the current public key and DID document fragment needed for
 * credential subject binding and OID4VP proof.
 */
function getHolderInfo() {
  if (!_hdRoot) throw new Error("Wallet locked");
  const child = deriveChildKey(_hdRoot, currentKeyIndex.value);
  const pubHex = publicKeyHex(child);
  return {
    did: holderDid.value,
    publicKeyHex: pubHex,
    keyIndex: currentKeyIndex.value,
  };
}

/**
 * Rotate to the next key. Updates vault with new keyIndex, currentPublicKey,
 * nextKeyHash. Caller is responsible for anchoring the KEL event on-chain
 * before calling this (pass the signed rotation event back to the server).
 */
async function rotateKey(pin) {
  if (!_hdRoot) throw new Error("Wallet locked");
  const encrypted = await dbGet(VAULT_KEY);
  const vaultData = await decryptVault(encrypted, pin);
  const newIndex = vaultData.keyIndex + 1;
  const currentChild = deriveChildKey(_hdRoot, newIndex);
  const nextChild = deriveChildKey(_hdRoot, newIndex + 1);
  const currentPubHex = publicKeyHex(currentChild);
  const nextPubHex = publicKeyHex(nextChild);

  vaultData.keyIndex = newIndex;
  vaultData.currentPublicKey = currentPubHex;
  vaultData.nextKeyHash = hashPublicKey(nextPubHex);
  vaultData.did = didFromPublicKey(currentPubHex);

  const reencrypted = await encryptVault(vaultData, pin);
  await dbPut(VAULT_KEY, reencrypted);

  currentKeyIndex.value = newIndex;
  holderDid.value = vaultData.did;
}

/** Permanently delete the wallet vault from IndexedDB */
async function deleteWallet() {
  lock();
  await dbDelete(VAULT_KEY);
  await dbDelete(META_KEY);
}

/** Return the stored DID without requiring PIN (public key, safe in plaintext). */
async function getStoredDid() {
  const meta = await dbGet(META_KEY);
  return meta?.did ?? null;
}

/**
 * Decrypt and return the mnemonic. Requires PIN (verifies it in the process).
 * Use sparingly — only needed when re-setting up location recovery.
 */
async function getMnemonic(pin) {
  const encrypted = await dbGet(VAULT_KEY);
  if (!encrypted) throw new Error("No wallet found.");
  const vaultData = await decryptVault(encrypted, pin);
  return vaultData.mnemonic;
}

export function useKeyVault() {
  return {
    isUnlocked: readonly(isUnlocked),
    holderDid: readonly(holderDid),
    currentKeyIndex: readonly(currentKeyIndex),
    hasVault,
    createWallet,
    importMnemonic,
    unlock,
    lock,
    sign,
    getHolderInfo,
    rotateKey,
    deleteWallet,
    getMnemonic,
    getStoredDid,
  };
}

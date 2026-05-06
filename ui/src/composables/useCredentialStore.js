/**
 * useCredentialStore.js
 *
 * Stores W3C VC 2.0 credentials.
 * - Web: IndexedDB
 * - Native (iOS/Android): capacitor-secure-storage-plugin
 * No server copy — holder owns their credentials.
 */

import { ref, readonly } from "vue";

const DB_NAME = "yadacoin_wallet";
const DB_VERSION = 1;
const CRED_STORE = "credentials";
const NATIVE_CREDS_KEY = "yadacoin_credentials";

const credentials = ref([]);

// ── Platform detection ────────────────────────────────────────────────────────
function isNative() {
  return (
    typeof window !== "undefined" &&
    window.Capacitor != null &&
    window.Capacitor.isNativePlatform()
  );
}

// ── Native storage (all credentials stored as JSON array under one key) ───────
async function nativeLoadAll() {
  const { SecureStoragePlugin } =
    await import("capacitor-secure-storage-plugin");
  try {
    const { value } = await SecureStoragePlugin.get({ key: NATIVE_CREDS_KEY });
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

async function nativeSaveAll(list) {
  const { SecureStoragePlugin } =
    await import("capacitor-secure-storage-plugin");
  await SecureStoragePlugin.set({
    key: NATIVE_CREDS_KEY,
    value: JSON.stringify(list),
  });
}

// ── IndexedDB (web) ───────────────────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CRED_STORE)) {
        const store = db.createObjectStore(CRED_STORE, { keyPath: "id" });
        store.createIndex("type", "type", { multiEntry: true });
        store.createIndex("issuer", "issuer", { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
async function loadAll() {
  if (isNative()) {
    credentials.value = await nativeLoadAll();
    return credentials.value;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CRED_STORE, "readonly");
    const req = tx.objectStore(CRED_STORE).getAll();
    req.onsuccess = (e) => {
      credentials.value = e.target.result;
      resolve(e.target.result);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveCredential(vc) {
  if (!vc.id) throw new Error("Credential missing 'id' field");
  if (isNative()) {
    const list = await nativeLoadAll();
    const idx = list.findIndex((c) => c.id === vc.id);
    if (idx >= 0) list[idx] = vc;
    else list.push(vc);
    await nativeSaveAll(list);
    credentials.value = list;
    return;
  }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CRED_STORE, "readwrite");
    const req = tx.objectStore(CRED_STORE).put(vc);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
  await loadAll();
}

async function deleteCredential(id) {
  if (isNative()) {
    const list = await nativeLoadAll();
    await nativeSaveAll(list.filter((c) => c.id !== id));
    credentials.value = credentials.value.filter((c) => c.id !== id);
    return;
  }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CRED_STORE, "readwrite");
    const req = tx.objectStore(CRED_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
  await loadAll();
}

export function useCredentialStore() {
  return {
    credentials: readonly(credentials),
    loadAll,
    saveCredential,
    deleteCredential,
  };
}

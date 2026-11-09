<template>
  <div class="receive-view">
    <h2>Receive a Credential</h2>
    <p class="hint">
      Scan a QR code from an issuer, or paste the credential offer link below.
    </p>

    <!-- QR scanner -->
    <div v-if="scanning" class="scanner-wrap">
      <video ref="videoEl" class="scanner-video" autoplay muted playsinline />
      <button class="btn-cancel" @click="stopScan">Cancel</button>
    </div>

    <button v-if="!scanning" class="btn-secondary" @click="startScan">
      📷 Scan QR Code
    </button>

    <textarea
      v-if="!scanning"
      v-model="offerInput"
      placeholder="openid-credential-offer://… or paste JSON offer"
      class="input"
      rows="4"
      aria-label="Credential offer URL or JSON"
    />

    <!-- tx_code (one-time PIN) — shown when issuer requires it -->
    <div v-if="!scanning && needsTxCode" class="txcode-wrap">
      <label class="field-label">
        One-Time PIN
        <span class="field-hint">Enter the code sent to you by the issuer</span>
      </label>
      <input
        v-model="txCode"
        type="text"
        inputmode="numeric"
        placeholder="e.g. 123456"
        class="input input--pin"
        autocomplete="one-time-code"
        aria-label="One-time PIN from issuer"
      />
    </div>

    <p v-if="errorMsg" class="error" role="alert">{{ errorMsg }}</p>

    <div v-if="status === 'done'" class="success" role="status">
      ✓ {{ received.length }} credential{{ received.length !== 1 ? "s" : "" }}
      received!
    </div>

    <button
      v-if="!scanning"
      class="btn-primary"
      :disabled="
        !offerInput.trim() || status === 'fetching' || status === 'receiving'
      "
      @click="receive"
    >
      {{ statusLabel }}
    </button>

    <!-- Divider -->
    <div v-if="!scanning" class="divider">
      <span>or import directly</span>
    </div>

    <!-- Direct VC import -->
    <div v-if="!scanning" class="import-wrap">
      <p class="hint">
        Paste a raw Verifiable Credential (JSON or JWT) to import it without an
        issuer flow.
      </p>
      <textarea
        v-model="importInput"
        placeholder='{"@context":…} or eyJ…'
        class="input"
        rows="4"
        aria-label="Raw Verifiable Credential JSON or JWT"
      />
      <p v-if="importError" class="error" role="alert">{{ importError }}</p>
      <div v-if="importDone" class="success" role="status">
        ✓ Credential imported!
      </div>
      <button
        class="btn-secondary"
        :disabled="!importInput.trim() || importing"
        @click="importRaw"
      >
        {{ importing ? "Importing…" : "Import Credential" }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from "vue";
import { useOID4VCI } from "../composables/useOID4VCI.js";

const { status, errorMsg, receiveCredential, parseOffer } = useOID4VCI();
const offerInput = ref("");
const received = ref([]);
const txCode = ref("");
const needsTxCode = ref(false);

// ── QR scanner ────────────────────────────────────────────────────────────────
const scanning = ref(false);
const videoEl = ref(null);
let _stream = null;
let _reader = null;

async function startScan() {
  errorMsg.value = "";
  try {
    // Use @capacitor/camera on native, getUserMedia on web
    if (window.Capacitor?.isNativePlatform()) {
      await startNativeScan();
    } else {
      await startWebScan();
    }
  } catch (err) {
    errorMsg.value = "Camera unavailable: " + err.message;
  }
}

async function startWebScan() {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  _reader = new BrowserMultiFormatReader();
  scanning.value = true;
  // Wait a tick for the DOM to render the video element
  await new Promise((r) => setTimeout(r, 50));
  _stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  videoEl.value.srcObject = _stream;
  _reader.decodeFromVideoElement(videoEl.value, (result, err) => {
    if (result) {
      offerInput.value = result.getText();
      stopScan();
    }
  });
}

async function startNativeScan() {
  const { Camera, CameraResultType, CameraSource } =
    await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Base64,
    source: CameraSource.Camera,
    quality: 90,
  });
  // Decode QR from captured image using ZXing
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const img = new Image();
  img.src = `data:image/jpeg;base64,${photo.base64String}`;
  await new Promise((resolve) => {
    img.onload = resolve;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const { BinaryBitmap, HybridBinarizer, HTMLCanvasElementLuminanceSource } =
    await import("@zxing/library");
  const luminance = new HTMLCanvasElementLuminanceSource(canvas);
  const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
  const reader = new BrowserMultiFormatReader();
  const result = reader.decodeBitmap(bitmap);
  offerInput.value = result.getText();
}

function stopScan() {
  if (_stream) {
    _stream.getTracks().forEach((t) => t.stop());
    _stream = null;
  }
  if (_reader) {
    _reader.reset?.();
    _reader = null;
  }
  scanning.value = false;
}

onUnmounted(() => stopScan());

// ── Receive flow ──────────────────────────────────────────────────────────────
const statusLabel = computed(() => {
  if (status.value === "fetching") return "Fetching offer…";
  if (status.value === "receiving") return "Receiving credential…";
  if (status.value === "done") return "Receive another";
  return "Receive";
});

async function receive() {
  received.value = [];
  needsTxCode.value = false;
  try {
    // Pre-parse to check if tx_code is required before making network calls
    let offer;
    try {
      offer = await parseOffer(offerInput.value.trim());
    } catch {
      offer = null;
    }
    const txRequired =
      offer?.grants?.["urn:ietf:params:oauth:grant-type:pre-authorized_code"]
        ?.tx_code;
    if (txRequired && !txCode.value.trim()) {
      needsTxCode.value = true;
      return;
    }
    received.value = await receiveCredential(
      offerInput.value.trim(),
      txCode.value.trim() || null,
    );
    offerInput.value = "";
    txCode.value = "";
  } catch {
    // error shown via errorMsg
  }
}

// ── Direct VC import ──────────────────────────────────────────────────────────
const importInput = ref("");
const importError = ref("");
const importDone = ref(false);
const importing = ref(false);

async function importRaw() {
  importError.value = "";
  importDone.value = false;
  importing.value = true;
  try {
    const raw = importInput.value.trim();
    let vc;
    if (raw.startsWith("{")) {
      vc = JSON.parse(raw);
    } else {
      // JWT: decode payload (no signature verification — issuer already signed it)
      const parts = raw.split(".");
      if (parts.length < 2) throw new Error("Not valid VC JSON or JWT");
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      // JWT VCs may have vc claim or be the VC itself
      vc = payload.vc || payload;
    }
    if (!vc["@context"] && !vc.type)
      throw new Error("Does not appear to be a Verifiable Credential");
    if (!vc.id) vc.id = `urn:import:${Date.now()}`;

    const { useCredentialStore } =
      await import("../composables/useCredentialStore.js");
    const store = useCredentialStore();
    await store.saveCredential(vc);

    importInput.value = "";
    importDone.value = true;
    setTimeout(() => {
      importDone.value = false;
    }, 3000);
  } catch (e) {
    importError.value = e.message || "Could not parse credential";
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.receive-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
h2 {
  font-size: 1.1rem;
}
.hint {
  font-size: 0.85rem;
  color: #666;
}
.scanner-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}
.scanner-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.btn-cancel {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.5rem 1.25rem;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 20px;
  font-size: 0.9rem;
  cursor: pointer;
}
.input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 0.9rem;
  resize: vertical;
}
.btn-primary {
  padding: 0.75rem;
  background: #1a1a2e;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  padding: 0.65rem;
  background: #f0f0f0;
  color: #333;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 0.95rem;
  cursor: pointer;
}
.txcode-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #333;
}
.field-hint {
  font-weight: 400;
  color: #666;
  margin-left: 0.4rem;
}
.input--pin {
  max-width: 200px;
  text-align: center;
  letter-spacing: 0.15em;
  font-size: 1.1rem;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.success {
  background: #d4edda;
  color: #155724;
  border-radius: 8px;
  padding: 0.75rem;
  font-size: 0.9rem;
}
.divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #bbb;
  font-size: 0.8rem;
  margin: 0.25rem 0;
}
.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e5e5e5;
}
.import-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

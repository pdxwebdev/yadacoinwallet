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
    />

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div v-if="status === 'done'" class="success">
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
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from "vue";
import { useOID4VCI } from "../composables/useOID4VCI.js";

const { status, errorMsg, receiveCredential } = useOID4VCI();
const offerInput = ref("");
const received = ref([]);

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
  try {
    received.value = await receiveCredential(offerInput.value.trim());
    offerInput.value = "";
  } catch {
    // error shown via errorMsg
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
</style>

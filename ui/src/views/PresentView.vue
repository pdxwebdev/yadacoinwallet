<template>
  <div class="present-view">
    <h2>Present Credentials</h2>

    <!-- Step 1: Load request -->
    <div v-if="!presentationRequest">
      <p class="hint">
        Paste a verifier request link or scan a QR code to begin.
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
        v-model="requestInput"
        placeholder="openid4vp://… or paste request JSON"
        class="input"
        rows="4"
        aria-label="Verifier request URL or JSON"
      />
      <p v-if="errorMsg" class="error" role="alert">{{ errorMsg }}</p>
      <button
        v-if="!scanning"
        class="btn-primary"
        :disabled="!requestInput.trim()"
        @click="loadRequest"
      >
        Load Request
      </button>
    </div>

    <!-- Step 2: Select credentials and choose claims -->
    <div v-else class="request-loaded">
      <div
        class="verifier-info"
        role="region"
        aria-label="Verifier information"
      >
        <strong>Verifier:</strong> {{ verifierName }}
      </div>

      <p class="section-label">
        Choose what to share
        <span class="privacy-note">Only checked items will be sent.</span>
      </p>

      <div
        v-for="cred in credentials"
        :key="cred.id"
        class="cred-card"
        :class="{
          selected: selectedIds.has(cred.id),
          unusable: !isCredentialUsable(cred.id),
        }"
        role="group"
        :aria-label="`${primaryType(cred)} credential`"
      >
        <!-- Credential header row -->
        <div
          class="cred-header"
          @click="toggleCred(cred.id)"
          :title="credStatusLabel(cred.id) || undefined"
        >
          <span
            class="cred-check"
            :aria-checked="selectedIds.has(cred.id)"
            role="checkbox"
            :tabindex="0"
            @keydown.space.prevent="toggleCred(cred.id)"
            @keydown.enter.prevent="toggleCred(cred.id)"
          >
            {{ selectedIds.has(cred.id) ? "☑" : "☐" }}
          </span>
          <div class="cred-meta">
            <div class="cred-type">{{ primaryType(cred) }}</div>
            <div class="cred-issuer">{{ issuerName(cred) }}</div>
            <div
              v-if="credStatusLabel(cred.id)"
              class="cred-status-warn"
              role="alert"
            >
              {{ credStatusLabel(cred.id) }}
            </div>
          </div>
          <button
            v-if="selectedIds.has(cred.id)"
            class="expand-btn"
            :aria-expanded="expandedIds.has(cred.id)"
            :aria-controls="`claims-${cred.id}`"
            @click.stop="toggleExpand(cred.id)"
          >
            {{ expandedIds.has(cred.id) ? "▲ Hide claims" : "▼ Choose claims" }}
          </button>
        </div>

        <!-- Claim selection panel — shown when credential is selected and expanded -->
        <div
          v-if="selectedIds.has(cred.id) && expandedIds.has(cred.id)"
          :id="`claims-${cred.id}`"
          class="claims-panel"
          role="group"
          aria-label="Claims to disclose"
        >
          <p class="claims-hint">
            Uncheck any claims you do not want to share.
            <span v-if="hasRequiredClaims(cred.id)" class="required-note">
              Claims marked <strong>required</strong> are needed by the
              verifier.
            </span>
          </p>

          <div
            v-for="claim in getClaimsForCred(cred)"
            :key="claim.name"
            class="claim-row"
            :class="{ required: isClaimRequired(cred.id, claim.name) }"
          >
            <label class="claim-label">
              <input
                type="checkbox"
                :checked="isClaimSelected(cred.id, claim.name)"
                :disabled="isClaimRequired(cred.id, claim.name)"
                @change="
                  toggleClaim(cred.id, claim.name, $event.target.checked)
                "
                :aria-label="`Share ${claim.name}`"
              />
              <span class="claim-name">{{ formatClaimName(claim.name) }}</span>
              <span
                v-if="isClaimRequired(cred.id, claim.name)"
                class="required-badge"
                aria-label="required by verifier"
                >required</span
              >
            </label>
            <div class="claim-value" aria-label="Claim value">
              {{ formatClaimValue(claim.value) }}
            </div>
          </div>
        </div>
      </div>

      <p class="no-creds-hint" v-if="credentials.length === 0">
        No credentials in your wallet yet. Use the Receive tab to add one.
      </p>

      <p v-if="vpStatus === 'done'" class="success" role="status">
        ✓ Presentation sent successfully.
      </p>
      <p v-if="errorMsg" class="error" role="alert">{{ errorMsg }}</p>

      <!-- QR code — shown after send or on demand for in-person verification -->
      <div v-if="qrDataUrl" class="qr-wrap">
        <p class="qr-label">Show this QR to the verifier</p>
        <img :src="qrDataUrl" class="qr-img" alt="VP token QR code" />
        <button class="btn-secondary btn-sm" @click="qrDataUrl = null">
          Close QR
        </button>
      </div>

      <div class="action-row">
        <button class="btn-secondary" @click="cancelPresentation">
          Cancel
        </button>
        <button
          v-if="vpStatus !== 'done'"
          class="btn-secondary"
          :disabled="selectedIds.size === 0 || vpStatus === 'presenting'"
          @click="submitQrOnly"
          title="Build VP and show as QR instead of sending to a server"
        >
          📲 Show QR
        </button>
        <button
          class="btn-primary"
          :disabled="selectedIds.size === 0 || vpStatus === 'presenting'"
          @click="submit"
        >
          {{
            vpStatus === "presenting"
              ? "Sending…"
              : `Share ${selectedIds.size > 0 ? selectedIds.size : ""} Credential${selectedIds.size !== 1 ? "s" : ""}`
          }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import QRCode from "qrcode";
import { useOID4VP, buildVpTokenFromSpecs } from "../composables/useOID4VP.js";
import { useCredentialStore } from "../composables/useCredentialStore.js";
import {
  isSdJwt,
  getSdJwtClaims,
  getVcClaims,
  getRequiredClaims,
} from "../composables/useSelectiveDisclosure.js";
import {
  checkAllCredentialStatuses,
  invalidateStatus,
} from "../composables/useCredentialStatus.js";

const {
  vpStatus,
  presentationRequest,
  errorMsg,
  fetchRequest,
  present,
  clearRequest,
} = useOID4VP();
const { credentials, loadAll } = useCredentialStore();

const requestInput = ref("");

// ── QR scanner ────────────────────────────────────────────────────────────────
const scanning = ref(false);
const videoEl = ref(null);
let _stream = null;
let _reader = null;

async function startScan() {
  errorMsg.value = "";
  try {
    if (window.Capacitor?.isNativePlatform()) {
      await _nativeScan();
    } else {
      await _webScan();
    }
  } catch (err) {
    errorMsg.value = "Camera unavailable: " + err.message;
  }
}

async function _webScan() {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  _reader = new BrowserMultiFormatReader();
  scanning.value = true;
  await new Promise((r) => setTimeout(r, 50));
  _stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  videoEl.value.srcObject = _stream;
  _reader.decodeFromVideoElement(videoEl.value, (result) => {
    if (result) {
      requestInput.value = result.getText();
      stopScan();
    }
  });
}

async function _nativeScan() {
  const { Camera, CameraResultType, CameraSource } =
    await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Base64,
    source: CameraSource.Camera,
    quality: 90,
  });
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const img = new Image();
  img.src = `data:image/jpeg;base64,${photo.base64String}`;
  await new Promise((r) => {
    img.onload = r;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const { BinaryBitmap, HybridBinarizer, HTMLCanvasElementLuminanceSource } =
    await import("@zxing/library");
  const result = new BrowserMultiFormatReader().decodeBitmap(
    new BinaryBitmap(
      new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas)),
    ),
  );
  requestInput.value = result.getText();
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

// Which credential IDs are selected for presentation
const selectedIds = ref(new Set());
// Which credential IDs have their claims panel expanded
const expandedIds = ref(new Set());
// Per-credential selected claim names: Map<credId, Set<claimName>>
const selectedClaimsMap = ref(new Map());
// Status map: Map<credId, statusResult>
const statusMap = ref(new Map());

onMounted(async () => {
  await loadAll();
  // Check status for all credentials so revoked ones are blocked before user tries to select
  if (credentials.value.length > 0) {
    const results = await checkAllCredentialStatuses(credentials.value);
    statusMap.value = results;
  }
});

const verifierName = computed(() => {
  const req = presentationRequest.value;
  if (!req) return "";
  return req.client_id || req.response_uri || "Unknown verifier";
});

async function loadRequest() {
  await fetchRequest(requestInput.value.trim());
  requestInput.value = "";
}

// ── Credential selection ──────────────────────────────────────────────────────

function isCredentialUsable(id) {
  const s = statusMap.value.get(id)?.status;
  // Allow "valid", "unknown" (no status field), "checking" (not yet checked), undefined
  return s !== "revoked" && s !== "suspended";
}

function credStatusLabel(id) {
  const s = statusMap.value.get(id)?.status;
  if (s === "revoked") return "Revoked — cannot present";
  if (s === "suspended") return "Suspended — cannot present";
  return null;
}

function toggleCred(id) {
  if (!isCredentialUsable(id)) return; // silently block revoked/suspended
  const s = new Set(selectedIds.value);
  if (s.has(id)) {
    s.delete(id);
    // Clean up expanded/claim state when deselecting
    const ex = new Set(expandedIds.value);
    ex.delete(id);
    expandedIds.value = ex;
    const cm = new Map(selectedClaimsMap.value);
    cm.delete(id);
    selectedClaimsMap.value = cm;
  } else {
    s.add(id);
    // Auto-initialise claims for this credential with all claims selected
    _initClaimsForCred(id);
    // Auto-expand so the user sees what will be shared
    const ex = new Set(expandedIds.value);
    ex.add(id);
    expandedIds.value = ex;
  }
  selectedIds.value = s;
}

function toggleExpand(id) {
  const ex = new Set(expandedIds.value);
  ex.has(id) ? ex.delete(id) : ex.add(id);
  expandedIds.value = ex;
}

// ── Claim selection ───────────────────────────────────────────────────────────

function getClaimsForCred(vc) {
  // Determine if this is an SD-JWT credential
  const raw = vc._rawSdJwt || vc._sd_jwt;
  if (raw && isSdJwt(raw)) {
    const { disclosableClaims } = getSdJwtClaims(raw);
    return disclosableClaims;
  }
  return getVcClaims(vc);
}

function _initClaimsForCred(credId) {
  const vc = credentials.value.find((c) => c.id === credId);
  if (!vc) return;
  const claims = getClaimsForCred(vc);
  const required = getRequiredClaims(
    presentationRequest.value?.presentation_definition,
    vc,
  );
  // Start with all claims selected (user can uncheck non-required ones)
  const selected = new Set(claims.map((c) => c.name));
  const cm = new Map(selectedClaimsMap.value);
  cm.set(credId, { selected, required });
  selectedClaimsMap.value = cm;
}

function isClaimSelected(credId, claimName) {
  return selectedClaimsMap.value.get(credId)?.selected?.has(claimName) ?? true;
}

function isClaimRequired(credId, claimName) {
  return selectedClaimsMap.value.get(credId)?.required?.has(claimName) ?? false;
}

function hasRequiredClaims(credId) {
  const r = selectedClaimsMap.value.get(credId)?.required;
  return r && r.size > 0;
}

function toggleClaim(credId, claimName, checked) {
  const cm = new Map(selectedClaimsMap.value);
  const entry = cm.get(credId);
  if (!entry) return;
  const selected = new Set(entry.selected);
  checked ? selected.add(claimName) : selected.delete(claimName);
  cm.set(credId, { ...entry, selected });
  selectedClaimsMap.value = cm;
}

// ── Submission ────────────────────────────────────────────────────────────────

const qrDataUrl = ref(null);

function _buildSpecs() {
  return credentials.value
    .filter((c) => selectedIds.value.has(c.id))
    .map((vc) => {
      const claimEntry = selectedClaimsMap.value.get(vc.id);
      const selectedClaims = claimEntry?.selected ?? new Set();
      const raw = vc._rawSdJwt || vc._sd_jwt;
      return {
        vc,
        selectedClaims,
        rawSdJwt: raw && isSdJwt(raw) ? raw : undefined,
      };
    });
}

async function submit() {
  qrDataUrl.value = null;
  await present(_buildSpecs());
  // Reset selection after successful presentation
  selectedIds.value = new Set();
  expandedIds.value = new Set();
  selectedClaimsMap.value = new Map();
}

/**
 * Build the VP locally and render it as a QR code without POSTing anywhere.
 * Used for in-person / kiosk verification where the verifier scans the wallet.
 */
async function submitQrOnly() {
  qrDataUrl.value = null;
  try {
    const token = await buildVpTokenFromSpecs(_buildSpecs());
    // Store on local server and encode the short retrieval URL in the QR
    const storeRes = await fetch("/wallet/test/vp-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vp_token: token }),
    });
    const { url } = await storeRes.json();
    qrDataUrl.value = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });
  } catch (e) {
    // silently skip — user can still use Send button
  }
}

function cancelPresentation() {
  clearRequest();
  selectedIds.value = new Set();
  expandedIds.value = new Set();
  selectedClaimsMap.value = new Map();
  requestInput.value = "";
}

// ── Display helpers ───────────────────────────────────────────────────────────

function primaryType(cred) {
  const types = Array.isArray(cred.type) ? cred.type : [cred.type];
  return (
    types
      .filter(
        (t) => t !== "VerifiablePresentation" && t !== "VerifiableCredential",
      )
      .join(", ") || "Credential"
  );
}

function issuerName(cred) {
  if (!cred.issuer) return "Unknown issuer";
  return typeof cred.issuer === "string"
    ? cred.issuer
    : cred.issuer.name || cred.issuer.id || "Unknown";
}

function formatClaimName(name) {
  // camelCase → "Camel Case"
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function formatClaimValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
</script>

<style scoped>
.present-view {
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
.input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 0.9rem;
  resize: vertical;
}
.verifier-info {
  background: #f0f4ff;
  border-radius: 8px;
  padding: 0.65rem;
  font-size: 0.88rem;
}

/* ── Credential cards ── */
.section-label {
  font-size: 0.9rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.privacy-note {
  font-size: 0.78rem;
  color: #667;
  font-weight: 400;
}
.cred-card {
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  overflow: hidden;
}
.cred-card.selected {
  border-color: #1a1a2e;
}
.cred-card.unusable {
  opacity: 0.6;
  border-color: #fcc;
  background: #fff8f8;
  cursor: not-allowed;
}
.cred-status-warn {
  font-size: 0.72rem;
  color: #c00;
  margin-top: 0.15rem;
}
.cred-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.75rem;
  cursor: pointer;
  user-select: none;
}
.cred-header:hover {
  background: #fafafa;
}
.cred-check {
  font-size: 1.3rem;
  width: 1.5rem;
  text-align: center;
  color: #1a1a2e;
  flex-shrink: 0;
  cursor: pointer;
}
.cred-check:focus {
  outline: 2px solid #1a1a2e;
  border-radius: 3px;
}
.cred-meta {
  flex: 1;
  min-width: 0;
}
.cred-type {
  font-weight: 600;
  font-size: 0.9rem;
}
.cred-issuer {
  font-size: 0.78rem;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.expand-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid #1a1a2e;
  border-radius: 6px;
  background: transparent;
  color: #1a1a2e;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.expand-btn:hover {
  background: #f0f4ff;
}

/* ── Claims panel ── */
.claims-panel {
  border-top: 1px solid #e5e5e5;
  background: #fafbff;
  padding: 0.65rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.claims-hint {
  font-size: 0.78rem;
  color: #555;
  margin-bottom: 0.35rem;
}
.required-note {
  color: #c00;
}
.claim-row {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
}
.claim-row:hover {
  background: #f0f4ff;
}
.claim-row.required {
  background: #fff8f0;
}
.claim-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.88rem;
}
.claim-label input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: #1a1a2e;
  flex-shrink: 0;
}
.claim-name {
  font-weight: 500;
}
.required-badge {
  font-size: 0.68rem;
  background: #fff0e0;
  color: #b45309;
  border: 1px solid #f6c26b;
  border-radius: 4px;
  padding: 0.1rem 0.35rem;
  margin-left: 0.25rem;
}
.claim-value {
  font-size: 0.78rem;
  color: #555;
  padding-left: 1.5rem;
  word-break: break-all;
}
.no-creds-hint {
  font-size: 0.85rem;
  color: #888;
  text-align: center;
  padding: 1rem 0;
}

/* ── Actions ── */
.action-row {
  display: flex;
  gap: 0.75rem;
}
.btn-primary,
.btn-secondary {
  flex: 1;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.btn-primary {
  background: #1a1a2e;
  color: #fff;
}
.btn-secondary {
  background: #e5e5e5;
  color: #1a1a2e;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.success {
  background: #d4edda;
  color: #155724;
  border-radius: 8px;
  padding: 0.65rem;
  font-size: 0.88rem;
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
.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  background: #f9f9f9;
  border: 1px solid #ddd;
  border-radius: 12px;
}
.qr-label {
  font-size: 0.82rem;
  color: #555;
}
.qr-img {
  width: 280px;
  height: 280px;
  image-rendering: pixelated;
}
.btn-sm {
  font-size: 0.8rem;
  padding: 0.35rem 0.75rem;
}
</style>

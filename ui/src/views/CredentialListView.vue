<template>
  <div class="cred-list">
    <div v-if="credentials.length === 0" class="empty">
      <p>No credentials yet.</p>
      <p class="hint">
        Use the <strong>Receive</strong> tab to get your first credential.
      </p>
    </div>

    <div
      v-for="cred in credentials"
      :key="cred.id"
      class="cred-card"
      :class="statusClass(cred.id)"
      :style="cardStyle(cred)"
      @click="selected = cred"
      :aria-label="`${credDisplayName(cred)}, ${statusLabel(cred.id)}`"
    >
      <div class="cred-header-row">
        <div class="cred-type-wrap">
          <!-- Issuer logo (display metadata) or OBv3 achievement image -->
          <img
            v-if="credLogo(cred)"
            :src="credLogo(cred)"
            class="cred-thumb"
            alt=""
            aria-hidden="true"
          />
          <div>
            <div class="cred-type" :style="cardTextStyle(cred)">
              {{ credDisplayName(cred) }}
            </div>
            <!-- OBv3 achievement name if different from type -->
            <div
              v-if="obv3AchievementName(cred)"
              class="cred-achievement"
              :style="cardTextStyle(cred)"
            >
              {{ obv3AchievementName(cred) }}
            </div>
            <!-- Issuer display description if present -->
            <div v-if="credDescription(cred)" class="cred-desc">
              {{ credDescription(cred) }}
            </div>
          </div>
        </div>
        <span
          class="status-badge"
          :class="`status-badge--${statusOf(cred.id)}`"
          :title="statusMessage(cred.id)"
          role="status"
          :aria-label="statusLabel(cred.id)"
          >{{ statusIcon(cred.id) }} {{ statusLabel(cred.id) }}</span
        >
      </div>
      <div class="cred-issuer" :style="cardTextStyle(cred)">
        {{ issuerName(cred) }}
      </div>
      <div class="cred-date" :style="cardTextStyle(cred)">
        Issued {{ formatDate(cred.validFrom || cred.issuanceDate) }}
      </div>
    </div>

    <!-- Detail modal -->
    <div v-if="selected" class="modal-overlay" @click.self="selected = null">
      <div
        class="modal"
        role="dialog"
        :aria-label="`${primaryType(selected)} details`"
      >
        <button class="modal-close" @click="selected = null" aria-label="Close">
          ✕
        </button>

        <!-- OBv3 achievement image -->
        <img
          v-if="obv3Image(selected)"
          :src="obv3Image(selected)"
          class="modal-badge-img"
          alt="Badge image"
        />

        <h3>{{ primaryType(selected) }}</h3>

        <!-- OBv3 achievement name -->
        <p v-if="obv3AchievementName(selected)" class="achievement-name">
          {{ obv3AchievementName(selected) }}
        </p>

        <p class="issuer-line">Issued by {{ issuerName(selected) }}</p>

        <!-- OBv3 criteria -->
        <div v-if="obv3Criteria(selected)" class="criteria-block">
          <div class="criteria-label">Criteria</div>
          <p class="criteria-text">{{ obv3Criteria(selected) }}</p>
        </div>

        <!-- Status detail in modal -->
        <div
          class="status-detail"
          :class="`status-detail--${statusOf(selected.id)}`"
          role="status"
        >
          <span>{{ statusIcon(selected.id) }}</span>
          <span>{{ statusMessage(selected.id) }}</span>
          <button
            v-if="
              statusOf(selected.id) === 'error' ||
              statusOf(selected.id) === 'checking'
            "
            class="recheck-btn"
            @click.stop="recheckOne(selected)"
            :disabled="statusOf(selected.id) === 'checking'"
          >
            {{ statusOf(selected.id) === "checking" ? "Checking…" : "↻ Retry" }}
          </button>
        </div>

        <div class="detail-section">
          <div
            v-for="[k, v] in subjectEntries(selected)"
            :key="k"
            class="detail-row"
          >
            <span class="detail-key">{{ formatKey(k) }}</span>
            <span class="detail-val">{{ v }}</span>
          </div>
        </div>

        <button class="btn-danger" @click="remove(selected.id)">
          Delete credential
        </button>
        <button class="btn-export" @click="exportCred(selected)">
          ↓ Export / Share
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useCredentialStore } from "../composables/useCredentialStore.js";
import {
  checkCredentialStatus,
  checkAllCredentialStatuses,
  invalidateStatus,
} from "../composables/useCredentialStatus.js";
import { getCredentialDisplay } from "../composables/useCredentialDisplay.js";

const store = useCredentialStore();
const { credentials, loadAll, deleteCredential } = store;
const selected = ref(null);

// Map<vcId, statusResult>
const statusMap = ref(new Map());

onMounted(async () => {
  await loadAll();
  await _checkAll();
});

async function _checkAll() {
  if (credentials.value.length === 0) return;
  // Set all to "checking" first so the UI shows a spinner immediately
  const checking = new Map(statusMap.value);
  for (const vc of credentials.value) {
    if (!checking.has(vc.id)) {
      checking.set(vc.id, {
        status: "checking",
        message: "Checking…",
        checkedAt: 0,
      });
    }
  }
  statusMap.value = new Map(checking);

  const results = await checkAllCredentialStatuses(credentials.value);
  statusMap.value = new Map([...statusMap.value, ...results]);
}

async function recheckOne(vc) {
  invalidateStatus(vc.id);
  const m = new Map(statusMap.value);
  m.set(vc.id, { status: "checking", message: "Checking…", checkedAt: 0 });
  statusMap.value = m;
  const result = await checkCredentialStatus(vc);
  const m2 = new Map(statusMap.value);
  m2.set(vc.id, result);
  statusMap.value = m2;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function statusOf(id) {
  return statusMap.value.get(id)?.status ?? "checking";
}
function statusMessage(id) {
  return statusMap.value.get(id)?.message ?? "Checking…";
}
function statusLabel(id) {
  const s = statusOf(id);
  return (
    {
      valid: "Valid",
      revoked: "Revoked",
      suspended: "Suspended",
      unknown: "Unknown",
      error: "Check failed",
      checking: "Checking",
    }[s] ?? s
  );
}
function statusIcon(id) {
  return (
    {
      valid: "✓",
      revoked: "✗",
      suspended: "⏸",
      unknown: "?",
      error: "!",
      checking: "…",
    }[statusOf(id)] ?? "?"
  );
}
function statusClass(id) {
  const s = statusOf(id);
  return s === "revoked"
    ? "cred-card--revoked"
    : s === "suspended"
      ? "cred-card--suspended"
      : "";
}

// ── Display helpers ───────────────────────────────────────────────────────────

function primaryType(cred) {
  const types = Array.isArray(cred.type) ? cred.type : [cred.type];
  return (
    types.filter((t) => t !== "VerifiableCredential").join(", ") || "Credential"
  );
}

function issuerName(cred) {
  if (!cred.issuer) return "Unknown issuer";
  if (typeof cred.issuer === "string") return cred.issuer;
  return cred.issuer.name || cred.issuer.id || "Unknown issuer";
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function subjectEntries(cred) {
  const subj = cred.credentialSubject || {};
  // Hide fields rendered specially (OBv3 achievement, id)
  const OBV3_SKIP = new Set([
    "id",
    "achievement",
    "activityEndDate",
    "activityStartDate",
  ]);
  return Object.entries(subj).filter(
    ([k, v]) => !OBV3_SKIP.has(k) && v != null && v !== "",
  );
}

// ── OBv3 helpers ──────────────────────────────────────────────────────────────

function _achievement(cred) {
  const subj = cred.credentialSubject || {};
  const a = subj.achievement;
  if (!a) return null;
  return Array.isArray(a) ? a[0] : a;
}

function obv3AchievementName(cred) {
  return _achievement(cred)?.name ?? null;
}

function obv3Criteria(cred) {
  const a = _achievement(cred);
  if (!a) return null;
  const c = a.criteria;
  if (!c) return null;
  return c.narrative || c.url || null;
}

function obv3Image(cred) {
  const a = _achievement(cred);
  if (!a) return null;
  const img = a.image;
  if (!img) return null;
  if (typeof img === "string") return img;
  return img.id || img.url || null;
}

// ── Issuer display metadata helpers ──────────────────────────────────────────

function _display(cred) {
  return getCredentialDisplay(cred);
}

function credDisplayName(cred) {
  return _display(cred).name || primaryType(cred);
}

function credDescription(cred) {
  return _display(cred).description || null;
}

function credLogo(cred) {
  const d = _display(cred);
  return d.logo?.uri || obv3Image(cred) || null;
}

function cardStyle(cred) {
  const d = _display(cred);
  if (!d.backgroundColor) return {};
  return { background: d.backgroundColor, borderColor: d.backgroundColor };
}

function cardTextStyle(cred) {
  const d = _display(cred);
  if (!d.textColor) return {};
  return { color: d.textColor };
}

function formatKey(k) {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

async function remove(id) {
  await deleteCredential(id);
  selected.value = null;
}

async function exportCred(vc) {
  const json = JSON.stringify(vc, null, 2);
  const filename = `credential-${vc.id?.slice(-8) ?? "export"}.json`;

  // Native: use Capacitor Share plugin if available
  if (window.Capacitor?.isNativePlatform()) {
    try {
      const { Share } = await import("@capacitor/share");
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      await Filesystem.writeFile({
        path: filename,
        data: btoa(unescape(encodeURIComponent(json))),
        directory: Directory.Cache,
      });
      const { uri } = await Filesystem.getUri({
        path: filename,
        directory: Directory.Cache,
      });
      await Share.share({ title: filename, url: uri });
      return;
    } catch {
      // fall through to web download
    }
  }

  // Web: trigger a file download
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.cred-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.empty {
  text-align: center;
  padding: 3rem 1rem;
  color: #888;
}
.hint {
  font-size: 0.9rem;
  margin-top: 0.5rem;
}

/* ── Credential cards ── */
.cred-card {
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  cursor: pointer;
  transition: box-shadow 0.15s;
}
.cred-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.cred-card--revoked {
  border-color: #fcc;
  background: #fff8f8;
  opacity: 0.85;
}
.cred-card--suspended {
  border-color: #f6c26b;
  background: #fffdf0;
}

.cred-header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}
.cred-type-wrap {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  min-width: 0;
}
.cred-thumb {
  width: 2.5rem;
  height: 2.5rem;
  object-fit: contain;
  border-radius: 4px;
  flex-shrink: 0;
}
.cred-type {
  font-weight: 600;
  font-size: 0.95rem;
}
.cred-achievement {
  font-size: 0.78rem;
  color: #444;
  margin-top: 0.1rem;
  font-style: italic;
}
.cred-desc {
  font-size: 0.75rem;
  color: #666;
  margin-top: 0.15rem;
}
.cred-issuer {
  font-size: 0.82rem;
  color: #555;
  margin-top: 0.2rem;
}
.cred-date {
  font-size: 0.78rem;
  color: #999;
  margin-top: 0.1rem;
}

/* ── Status badges ── */
.status-badge {
  font-size: 0.68rem;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
  flex-shrink: 0;
}
.status-badge--valid {
  background: #d4edda;
  color: #155724;
}
.status-badge--revoked {
  background: #f8d7da;
  color: #721c24;
}
.status-badge--suspended {
  background: #fff3cd;
  color: #856404;
}
.status-badge--unknown {
  background: #e9ecef;
  color: #495057;
}
.status-badge--error {
  background: #fff3cd;
  color: #856404;
}
.status-badge--checking {
  background: #e9ecef;
  color: #495057;
  font-style: italic;
}

/* ── Status detail in modal ── */
.status-detail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  margin-bottom: 0.75rem;
}
.status-detail--valid {
  background: #d4edda;
  color: #155724;
}
.status-detail--revoked {
  background: #f8d7da;
  color: #721c24;
}
.status-detail--suspended {
  background: #fff3cd;
  color: #856404;
}
.status-detail--unknown {
  background: #e9ecef;
  color: #495057;
}
.status-detail--error {
  background: #fff3cd;
  color: #856404;
}
.status-detail--checking {
  background: #e9ecef;
  color: #495057;
}
.recheck-btn {
  margin-left: auto;
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.recheck-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: flex-end;
  z-index: 100;
}
.modal {
  background: #fff;
  border-radius: 16px 16px 0 0;
  padding: 1.5rem;
  width: 100%;
  max-height: 80dvh;
  overflow-y: auto;
}
.modal-close {
  float: right;
  background: none;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  color: #888;
}
.modal-badge-img {
  display: block;
  width: 5rem;
  height: 5rem;
  object-fit: contain;
  margin: 0 auto 0.75rem;
  border-radius: 8px;
}
.achievement-name {
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
  color: #1a1a2e;
  margin: 0.1rem 0 0.5rem;
}
.criteria-block {
  background: #f8faff;
  border: 1px solid #dde5ff;
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
  margin-bottom: 0.75rem;
}
.criteria-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #666;
  margin-bottom: 0.3rem;
}
.criteria-text {
  font-size: 0.85rem;
  color: #333;
  line-height: 1.5;
  margin: 0;
}
.issuer-line {
  font-size: 0.85rem;
  color: #555;
  margin: 0.25rem 0 1rem;
}
.detail-section {
  border-top: 1px solid #eee;
  padding-top: 0.75rem;
  margin-bottom: 1rem;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  padding: 0.35rem 0;
  border-bottom: 1px solid #f5f5f5;
  font-size: 0.9rem;
}
.detail-key {
  color: #666;
}
.detail-val {
  font-weight: 500;
  text-align: right;
  max-width: 60%;
}
.btn-danger {
  width: 100%;
  padding: 0.65rem;
  background: #fff0f0;
  color: #c00;
  border: 1px solid #fcc;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}
.btn-export {
  width: 100%;
  padding: 0.65rem;
  background: #f0f4ff;
  color: #1a1a2e;
  border: 1px solid #c0ccee;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
}
</style>

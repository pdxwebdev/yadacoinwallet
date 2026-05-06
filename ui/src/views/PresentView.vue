<template>
  <div class="present-view">
    <h2>Present Credentials</h2>

    <div v-if="!presentationRequest">
      <p class="hint">
        Paste a verifier request link or scan a QR code to begin.
      </p>
      <textarea
        v-model="requestInput"
        placeholder="openid4vp://… or paste request JSON"
        class="input"
        rows="4"
      />
      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
      <button
        class="btn-primary"
        :disabled="!requestInput.trim()"
        @click="loadRequest"
      >
        Load Request
      </button>
    </div>

    <div v-else class="request-loaded">
      <div class="verifier-info">
        <strong>Verifier:</strong> {{ verifierName }}
      </div>

      <p class="select-label">Select credentials to share:</p>
      <div
        v-for="cred in credentials"
        :key="cred.id"
        class="cred-option"
        :class="{ selected: selectedIds.has(cred.id) }"
        @click="toggleCred(cred.id)"
      >
        <span class="check">{{ selectedIds.has(cred.id) ? "✓" : "○" }}</span>
        <div>
          <div class="cred-type">{{ primaryType(cred) }}</div>
          <div class="cred-issuer">{{ issuerName(cred) }}</div>
        </div>
      </div>

      <p v-if="vpStatus === 'done'" class="success">
        ✓ Presentation sent successfully.
      </p>
      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

      <div class="action-row">
        <button class="btn-secondary" @click="clearRequest">Cancel</button>
        <button
          class="btn-primary"
          :disabled="selectedIds.size === 0 || vpStatus === 'presenting'"
          @click="submit"
        >
          {{ vpStatus === "presenting" ? "Sending…" : "Present" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useOID4VP } from "../composables/useOID4VP.js";
import { useCredentialStore } from "../composables/useCredentialStore.js";

const {
  vpStatus,
  presentationRequest,
  errorMsg,
  fetchRequest,
  present,
  clearRequest,
} = useOID4VP();
const store = useCredentialStore();
const { credentials, loadAll } = store;

const requestInput = ref("");
const selectedIds = ref(new Set());

onMounted(() => loadAll());

const verifierName = computed(() => {
  const req = presentationRequest.value;
  if (!req) return "";
  return req.client_id || req.response_uri || "Unknown verifier";
});

async function loadRequest() {
  await fetchRequest(requestInput.value.trim());
  requestInput.value = "";
}

function toggleCred(id) {
  const s = new Set(selectedIds.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selectedIds.value = s;
}

async function submit() {
  const selected = credentials.value.filter((c) => selectedIds.value.has(c.id));
  await present(selected);
  selectedIds.value = new Set();
}

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
.select-label {
  font-size: 0.9rem;
  font-weight: 600;
}
.cred-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 0.65rem;
  cursor: pointer;
}
.cred-option.selected {
  border-color: #1a1a2e;
  background: #f0f4ff;
}
.check {
  font-size: 1.2rem;
  width: 1.5rem;
  text-align: center;
  color: #1a1a2e;
}
.cred-type {
  font-weight: 600;
  font-size: 0.9rem;
}
.cred-issuer {
  font-size: 0.78rem;
  color: #666;
}
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
</style>

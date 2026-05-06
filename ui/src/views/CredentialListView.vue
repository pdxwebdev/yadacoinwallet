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
      @click="selected = cred"
    >
      <div class="cred-type">{{ primaryType(cred) }}</div>
      <div class="cred-issuer">{{ issuerName(cred) }}</div>
      <div class="cred-date">
        Issued {{ formatDate(cred.validFrom || cred.issuanceDate) }}
      </div>
      <span v-if="cred.proof" class="signed-badge">✓ signed</span>
    </div>

    <!-- Detail modal -->
    <div v-if="selected" class="modal-overlay" @click.self="selected = null">
      <div class="modal">
        <button class="modal-close" @click="selected = null">✕</button>
        <h3>{{ primaryType(selected) }}</h3>
        <p class="issuer-line">Issued by {{ issuerName(selected) }}</p>

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
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useCredentialStore } from "../composables/useCredentialStore.js";

const store = useCredentialStore();
const { credentials, loadAll, deleteCredential } = store;
const selected = ref(null);

onMounted(() => loadAll());

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
  return Object.entries(subj).filter(
    ([k, v]) => k !== "id" && v != null && v !== "",
  );
}

function formatKey(k) {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

async function remove(id) {
  await deleteCredential(id);
  selected.value = null;
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
.cred-card {
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  cursor: pointer;
  position: relative;
  transition: box-shadow 0.15s;
}
.cred-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.cred-type {
  font-weight: 600;
  font-size: 0.95rem;
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
.signed-badge {
  position: absolute;
  top: 0.6rem;
  right: 0.75rem;
  font-size: 0.72rem;
  background: #d4edda;
  color: #155724;
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
}
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
}
</style>

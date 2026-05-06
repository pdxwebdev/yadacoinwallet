<template>
  <div class="settings-view">
    <h2>Settings</h2>

    <!-- Location recovery setup (shown inline) -->
    <template v-if="showLocationSetup">
      <LocationRecoverySetupView
        v-if="!locationCode"
        @setup-complete="onLocationSetupComplete"
        @skip="showLocationSetup = false"
      />
      <div v-else class="code-success">
        <p class="code-success-title">Location Recovery Updated</p>
        <p class="code-label">Your Recovery Code</p>
        <div class="code-display">{{ locationCode }}</div>
        <p class="code-instructions">
          Write this code down. To recover your wallet on any device, enter this
          code and re-pin your {{ LOCATION_COUNT }} locations.
        </p>
        <button
          class="btn-primary"
          @click="
            showLocationSetup = false;
            locationCode = '';
          "
        >
          Done
        </button>
      </div>
    </template>

    <template v-else>
      <section class="settings-section">
        <h3>Location Recovery</h3>
        <p class="desc">
          Pick {{ LOCATION_COUNT }} meaningful places on a map. Re-pin those
          places on any device to restore your wallet. Your coordinates never
          leave this device.
        </p>
        <button class="btn-primary" @click="showLocationSetup = true">
          Set Up Location Recovery
        </button>
      </section>

      <section class="settings-section">
        <h3>Wallet Info</h3>
        <p class="desc">Your decentralized identifier (DID):</p>
        <div class="code-row">
          <code class="did-text">{{ did }}</code>
          <button class="btn-copy" :class="{ copied }" @click="copyDid">
            {{ copied ? "Copied!" : "Copy" }}
          </button>
        </div>
        <p class="desc muted">Key index: {{ keyIndex }}</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useKeyVault } from "../composables/useKeyVault.js";
import { LOCATION_COUNT } from "../composables/useLocationRecovery.js";
import LocationRecoverySetupView from "./LocationRecoverySetupView.vue";

const vault = useKeyVault();

const showLocationSetup = ref(false);
const locationCode = ref("");

const info = vault.getHolderInfo();
const did = info?.did ?? vault.holderDid?.value ?? "";
const keyIndex = info?.keyIndex ?? 0;
const copied = ref(false);

function copyDid() {
  navigator.clipboard?.writeText(did).then(() => {
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  });
}

function onLocationSetupComplete({ code }) {
  // We don't import the mnemonic here — the vault already exists.
  // Just show the new recovery code to the user.
  locationCode.value = code;
}
</script>

<style scoped>
.settings-view {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
h2 {
  font-size: 1.1rem;
  font-weight: 700;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  padding: 1rem;
}
h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0;
}
.desc {
  font-size: 0.85rem;
  color: #555;
  line-height: 1.5;
  margin: 0;
}
.did-text code {
  font-size: 0.75rem;
  word-break: break-all;
}
.input {
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 1rem;
  width: 100%;
}
.btn-primary {
  padding: 0.6rem 1rem;
  border-radius: 8px;
  border: none;
  font-size: 0.9rem;
  cursor: pointer;
  background: #1a1a2e;
  color: #fff;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.code-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  background: #f5f5f5;
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}
.did-text {
  font-size: 0.7rem;
  word-break: break-all;
  flex: 1;
}
.btn-copy {
  padding: 0.35rem 0.6rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #fff;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s;
}
.btn-copy.copied {
  background: #d4edda;
  border-color: #c3e6cb;
}
.muted {
  color: #999;
}
.code-success {
  background: #fff8e1;
  border: 2px solid #f0a500;
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.code-success-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: #a06000;
  margin: 0;
}
.code-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #a06000;
  margin: 0;
}
.code-display {
  font-size: 1.8rem;
  font-weight: 800;
  letter-spacing: 0.15em;
  text-align: center;
  font-family: monospace;
  background: #fff;
  border-radius: 8px;
  padding: 0.4rem 1rem;
  border: 1px solid #ddd;
  color: #1a1a2e;
}
.code-instructions {
  font-size: 0.85rem;
  color: #555;
  line-height: 1.5;
  margin: 0;
}
</style>

<template>
  <div class="loc-setup">
    <h2>Set Up Location Recovery</h2>
    <p class="hint">
      Pick {{ LOCATION_COUNT }} meaningful places on the map and give each a
      private hint. Your wallet mnemonic will be encrypted with a key derived
      from these locations — coordinates never leave your device.
    </p>

    <!-- Progress indicator -->
    <div class="progress-row">
      <span
        v-for="i in LOCATION_COUNT"
        :key="i"
        class="dot"
        :class="{
          done: i - 1 < locations.length,
          active: i - 1 === locations.length,
        }"
      />
    </div>

    <p v-if="locations.length < LOCATION_COUNT" class="step-label">
      Location {{ locations.length + 1 }} of {{ LOCATION_COUNT }}: tap the map
      to zoom in, then select a grid cell
    </p>

    <!-- Map -->
    <Map
      ref="mapEl"
      :center="mapCenter"
      :zoom="initialZoom"
      :precision="4"
      :map-container-style="{
        width: '100%',
        height: '300px',
        borderRadius: '10px',
        overflow: 'hidden',
        border: '1px solid #ccc',
      }"
      v-model:selected-location="selectedLocation"
      v-model:selected-square-id="selectedSquareId"
      v-model:hover-index="hoverIndex"
      @grid-square-clicked="onGridSquareClicked"
    />
    <p class="map-hint">
      Tap the map to zoom in. When the grid appears, click a cell to select your
      location.
    </p>

    <!-- Hint input (shown after grid square selected, before confirming) -->
    <div v-if="pendingPin" class="hint-row">
      <input
        v-model="pendingHint"
        class="input"
        placeholder="Private hint (only you will see this)"
        maxlength="80"
        @keyup.enter="confirmPin"
      />
      <button class="btn-primary" @click="confirmPin">Add</button>
      <button class="btn-cancel" @click="cancelPin">Cancel</button>
    </div>

    <!-- List of added locations -->
    <ul v-if="locations.length" class="loc-list">
      <li v-for="(loc, i) in locations" :key="i">
        <span class="loc-num">{{ i + 1 }}</span>
        <span class="loc-hint">{{ loc.hint || "(no hint)" }}</span>
        <span class="loc-coord"
          >{{ loc.lat.toFixed(4) }}, {{ loc.lng.toFixed(4) }}</span
        >
        <button class="btn-remove" @click="removeLocation(i)">✕</button>
      </li>
    </ul>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div
      v-if="locations.length === LOCATION_COUNT && !saving && !recoveryCode"
      class="action-row"
    >
      <button class="btn-primary" @click="save">
        Save &amp; Generate Recovery Code
      </button>
      <button class="btn-skip" @click="$emit('skip')">Cancel</button>
    </div>
    <p v-if="saving" class="status">Deriving wallet from locations…</p>

    <!-- Recovery code reveal screen -->
    <div v-if="recoveryCode" class="recovery-code-screen">
      <p class="code-label">Your Recovery Code</p>
      <div class="code-display">{{ recoveryCode }}</div>
      <p class="code-instructions">
        Write this code down and store it safely. If you ever need to recover
        your wallet, enter this code on any device and re-pin your
        {{ LOCATION_COUNT }} locations — your wallet will be restored
        automatically.
      </p>
      <p class="code-note">
        The code only unlocks your hint labels. Your wallet mnemonic is
        encrypted with a zero-knowledge key derived from your 3 locations — it
        never leaves this device in plaintext.
      </p>
      <button class="btn-primary" @click="emitDone">
        I've written it down →
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import Map from "../components/Map.vue";
import {
  setupLocationRecovery,
  LOCATION_COUNT,
} from "../composables/useLocationRecovery.js";

// If provided, this existing mnemonic is what gets encrypted by the ZKP key.
// If omitted (creating a new wallet from locations), a fresh one is generated.
// prevKeyHash: hex hash of the latest key log entry — bound into the Schnorr
// challenge so the proof is tied to a specific key rotation (pass null until
// blockchain integration is complete).
const props = defineProps({
  existingMnemonic: { type: String, default: null },
  prevKeyHash: { type: String, default: null },
});
const emit = defineEmits(["setup-complete", "skip"]);

const mapEl = ref(null);
const locations = ref([]);
const pendingPin = ref(null); // {lat, lng} waiting for hint
const pendingHint = ref("");
const errorMsg = ref("");
const saving = ref(false);
const recoveryCode = ref("");
const derivedMnemonic = ref("");
const txnData = ref(null);

// Map state
const initialZoom = 2;
const mapCenter = ref({ lat: 0, lng: 0 });
const selectedLocation = ref({ lat: 0, lng: 0, confirmed: false });
const selectedSquareId = ref("");
const hoverIndex = ref(-1);

function onGridSquareClicked({ lat, lng }) {
  if (locations.value.length >= LOCATION_COUNT) return;
  if (pendingPin.value) return;
  pendingPin.value = { lat, lng };
  pendingHint.value = "";
}

function confirmPin() {
  if (!pendingPin.value) return;
  const loc = { ...pendingPin.value, hint: pendingHint.value.trim() };
  locations.value.push(loc);
  pendingPin.value = null;
  pendingHint.value = "";
  selectedSquareId.value = "";
  selectedLocation.value = { lat: 0, lng: 0, confirmed: false };
  // Reset map back to world view for next selection
  mapEl.value?.reset(initialZoom, { lat: 0, lng: 0 });
}

function cancelPin() {
  pendingPin.value = null;
  pendingHint.value = "";
  selectedSquareId.value = "";
  selectedLocation.value = { lat: 0, lng: 0, confirmed: false };
  mapEl.value?.reset(initialZoom, { lat: 0, lng: 0 });
}

function removeLocation(idx) {
  locations.value.splice(idx, 1);
}

async function save() {
  errorMsg.value = "";
  saving.value = true;
  try {
    const result = await setupLocationRecovery(
      locations.value,
      props.existingMnemonic ?? null,
      props.prevKeyHash ?? null,
    );
    derivedMnemonic.value = result.mnemonic;
    recoveryCode.value = result.code;
    txnData.value = result.txnData;
  } catch (e) {
    errorMsg.value = e.message;
  } finally {
    saving.value = false;
  }
}

function emitDone() {
  emit("setup-complete", {
    mnemonic: derivedMnemonic.value,
    code: recoveryCode.value,
    txnData: txnData.value,
  });
}
</script>

<style scoped>
.loc-setup {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
h2 {
  font-size: 1.1rem;
}
.hint {
  font-size: 0.85rem;
  color: #555;
  line-height: 1.5;
}
.progress-row {
  display: flex;
  gap: 6px;
}
.dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ddd;
  border: 2px solid #ccc;
  transition: background 0.2s;
}
.dot.done {
  background: #1a1a2e;
  border-color: #1a1a2e;
}
.dot.active {
  background: #fff;
  border-color: #1a1a2e;
}
.step-label {
  font-size: 0.9rem;
  font-weight: 500;
}
.map-hint {
  font-size: 0.8rem;
  color: #777;
  text-align: center;
  margin-top: -0.25rem;
}
.hint-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.input {
  flex: 1;
  padding: 0.55rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 0.9rem;
}
.loc-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.loc-list li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: #f5f5f5;
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
}
.loc-num {
  font-weight: 700;
  color: #1a1a2e;
  min-width: 1.2rem;
}
.loc-hint {
  flex: 1;
}
.loc-coord {
  color: #888;
  font-size: 0.75rem;
}
.btn-remove {
  background: none;
  border: none;
  color: #c00;
  cursor: pointer;
  font-size: 0.9rem;
}
.btn-primary,
.btn-cancel,
.btn-skip {
  padding: 0.6rem 1rem;
  border-radius: 8px;
  border: none;
  font-size: 0.9rem;
  cursor: pointer;
}
.btn-primary {
  background: #1a1a2e;
  color: #fff;
}
.btn-cancel {
  background: #eee;
  color: #333;
}
.btn-skip {
  background: none;
  color: #666;
  text-decoration: underline;
}
.action-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.recovery-code-screen {
  background: #fff8e1;
  border: 2px solid #f0a500;
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.code-label {
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #a06000;
  margin: 0;
}
.code-display {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: 0.15em;
  text-align: center;
  color: #1a1a2e;
  background: #fff;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  border: 1px solid #ddd;
  font-family: monospace;
}
.code-instructions {
  font-size: 0.88rem;
  line-height: 1.5;
  color: #333;
  margin: 0;
}
.code-note {
  font-size: 0.8rem;
  color: #777;
  margin: 0;
}
.status {
  color: #666;
  font-size: 0.85rem;
}

/* Numbered pin icon */
:global(.loc-pin) {
  width: 28px;
  height: 28px;
  background: #1a1a2e;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
</style>

<template>
  <div class="loc-recover">
    <h2>Recover with Locations</h2>

    <!-- Step 1: Enter Recovery Code -->
    <div v-if="step === 'code'">
      <p class="hint">
        Enter your Recovery Code to load your location hints. If you don't have
        a code, you can still recover by pinning your {{ LOCATION_COUNT }}
        locations without hints.
      </p>
      <input
        v-model="enteredCode"
        class="input"
        placeholder="e.g. 7KMN-2QPR"
        spellcheck="false"
        autocomplete="off"
        @keyup.enter="fetchHints"
      />
      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
      <button class="btn-primary" :disabled="fetchingHints" @click="fetchHints">
        {{ fetchingHints ? "Looking up…" : "Load Hints" }}
      </button>
      <button class="btn-skip-code" @click="skipCode">
        Continue without a Recovery Code
      </button>
      <button class="btn-back" @click="$emit('cancel')">← Back</button>
    </div>

    <!-- Loading hints from server -->
    <div v-else-if="step === 'loading'" class="loading-state">
      <p>Loading your recovery hints…</p>
    </div>

    <!-- Map: re-pin locations -->
    <div v-else-if="step === 'map'">
      <p class="step-label">
        Location {{ locations.length + 1 }} of {{ LOCATION_COUNT }}
      </p>
      <div class="hint-card">
        <span class="hint-num">{{ locations.length + 1 }}</span>
        <span class="hint-text">{{
          hints[locations.length] || "(no hint)"
        }}</span>
      </div>

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

      <div class="map-wrap">
        <Map
          ref="mapComponent"
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
          Tap the map to zoom in. When the grid appears, click a cell to select
          your location.
        </p>
      </div>

      <div v-if="pendingPin" class="pending-row">
        <span class="pending-label">Confirm this location?</span>
        <button class="btn-primary" @click="confirmPin">Yes, add it</button>
        <button class="btn-cancel" @click="cancelPin">Move pin</button>
      </div>

      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
      <button class="btn-back" @click="$emit('cancel')">← Cancel</button>
    </div>

    <!-- New PIN -->
    <div v-else-if="step === 'pin'">
      <p class="hint">
        Great — all {{ LOCATION_COUNT }} locations placed! A zero-knowledge
        proof will verify them against the stored commitment. Choose a new PIN
        to protect your restored wallet on this device.
      </p>
      <input
        v-model="newPin"
        type="password"
        inputmode="numeric"
        placeholder="New PIN (6+ characters)"
        class="input"
        autocomplete="new-password"
      />
      <input
        v-model="newPinConfirm"
        type="password"
        inputmode="numeric"
        placeholder="Confirm PIN"
        class="input"
        autocomplete="new-password"
      />
      <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
      <button class="btn-primary" :disabled="restoring" @click="restore">
        {{ restoring ? "Restoring…" : "Restore Wallet" }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import Map from "../components/Map.vue";
import { useKeyVault } from "../composables/useKeyVault.js";
import {
  getLocationHints,
  recoverWithLocations,
  LOCATION_COUNT,
} from "../composables/useLocationRecovery.js";

const emit = defineEmits(["recovered", "cancel"]);
const vault = useKeyVault();

const step = ref("code"); // code → loading → map → pin
const enteredCode = ref("");
const fetchingHints = ref(false);
const hints = ref([]);
const locations = ref([]);
const pendingPin = ref(null);
const newPin = ref("");
const newPinConfirm = ref("");
const errorMsg = ref("");
const restoring = ref(false);

// Map state
const mapComponent = ref(null);
const initialZoom = 2;
const mapCenter = ref({ lat: 0, lng: 0 });
const selectedLocation = ref({ lat: 0, lng: 0, confirmed: false });
const selectedSquareId = ref("");
const hoverIndex = ref(-1);

async function fetchHints() {
  errorMsg.value = "";
  const code = enteredCode.value.trim();
  if (!code) {
    errorMsg.value = "Please enter your Recovery Code.";
    return;
  }
  fetchingHints.value = true;
  try {
    const h = await getLocationHints(code);
    hints.value = h ?? [];
    if (!h) {
      errorMsg.value =
        "Recovery Code not found. You can still recover by re-pinning your locations without hints.";
    }
  } catch {
    hints.value = [];
    errorMsg.value = "Could not reach the server. Continuing without hints.";
  } finally {
    fetchingHints.value = false;
  }
  step.value = "map";
}

function skipCode() {
  hints.value = [];
  step.value = "map";
}

function onGridSquareClicked({ lat, lng }) {
  if (locations.value.length >= LOCATION_COUNT) return;
  if (pendingPin.value) return;
  pendingPin.value = { lat, lng };
}

function confirmPin() {
  if (!pendingPin.value) return;
  locations.value.push({ ...pendingPin.value });
  pendingPin.value = null;
  selectedSquareId.value = "";
  selectedLocation.value = { lat: 0, lng: 0, confirmed: false };
  if (locations.value.length === LOCATION_COUNT) {
    step.value = "pin";
  } else {
    mapComponent.value?.reset(initialZoom, { lat: 0, lng: 0 });
  }
}

function cancelPin() {
  pendingPin.value = null;
  selectedSquareId.value = "";
  selectedLocation.value = { lat: 0, lng: 0, confirmed: false };
  mapComponent.value?.reset(initialZoom, { lat: 0, lng: 0 });
}

async function restore() {
  errorMsg.value = "";
  if (newPin.value.length < 6) {
    errorMsg.value = "PIN must be at least 6 characters.";
    return;
  }
  if (newPin.value !== newPinConfirm.value) {
    errorMsg.value = "PINs don't match.";
    return;
  }
  restoring.value = true;
  try {
    const mnemonic = await recoverWithLocations(locations.value);
    await vault.importMnemonic(mnemonic, newPin.value);
    emit("recovered");
  } catch (e) {
    errorMsg.value = e.message;
    locations.value = [];
    step.value = "map";
    mapComponent.value?.reset(initialZoom, { lat: 0, lng: 0 });
  } finally {
    restoring.value = false;
  }
}
</script>

<style scoped>
.loc-recover {
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
.hint-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: #f0f4ff;
  border-radius: 10px;
  padding: 0.65rem 0.85rem;
  font-size: 0.9rem;
}
.hint-num {
  font-weight: 700;
  color: #1a1a2e;
  font-size: 1.1rem;
  min-width: 1.4rem;
}
.hint-text {
  flex: 1;
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
.map-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.map-hint {
  font-size: 0.8rem;
  color: #777;
  text-align: center;
}
.pending-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.pending-label {
  font-size: 0.85rem;
  flex: 1 1 100%;
}
.input {
  padding: 0.55rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 0.9rem;
  width: 100%;
}
.btn-primary,
.btn-cancel,
.btn-back,
.btn-skip-code {
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
.btn-back {
  background: none;
  color: #666;
  text-decoration: underline;
  padding: 0;
}
.btn-skip-code {
  background: none;
  color: #888;
  text-decoration: underline;
  display: block;
  padding: 0.25rem 0;
  margin-top: 0.25rem;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.loading-state {
  padding: 2rem;
  text-align: center;
  color: #888;
}

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

<template>
  <div class="loc-setup">
    <h2>Set Up Location Recovery</h2>
    <p class="hint">
      Pick {{ LOCATION_COUNT }} meaningful places on the map and give each a
      private hint. When you need to recover your wallet, you'll re-pin each
      location to within ~11 meters. Your coordinates never leave your device.
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
      to place a pin
    </p>

    <!-- Map -->
    <div ref="mapEl" class="map" />

    <!-- Hint input (shown after pin placed, before confirming) -->
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
        The code only unlocks your hint labels. Your wallet is secured by the
        locations themselves — they never leave this device.
      </p>
      <button class="btn-primary" @click="emitDone">
        I've written it down →
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import {
  setupLocationRecovery,
  LOCATION_COUNT,
} from "../composables/useLocationRecovery.js";

// No mnemonic prop needed — the mnemonic is derived from the locations
const emit = defineEmits(["setup-complete", "skip"]);

const mapEl = ref(null);
const locations = ref([]);
const pendingPin = ref(null); // {lat, lng} waiting for hint
const pendingHint = ref("");
const errorMsg = ref("");
const saving = ref(false);
const recoveryCode = ref("");
const derivedMnemonic = ref("");

let leafletMap = null;
let markers = [];
let tempMarker = null;

onMounted(async () => {
  const L = await import("leaflet");
  await import("leaflet/dist/leaflet.css");

  // Fix default marker icon path broken by bundlers
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: new URL(
      "leaflet/dist/images/marker-icon-2x.png",
      import.meta.url,
    ).href,
    iconUrl: new URL("leaflet/dist/images/marker-icon.png", import.meta.url)
      .href,
    shadowUrl: new URL("leaflet/dist/images/marker-shadow.png", import.meta.url)
      .href,
  });

  leafletMap = L.map(mapEl.value).setView([37.3861, -122.0839], 11); // default: Silicon Valley
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(leafletMap);

  // Try to center on user's location
  navigator.geolocation?.getCurrentPosition((pos) => {
    leafletMap.setView([pos.coords.latitude, pos.coords.longitude], 13);
  });

  leafletMap.on("click", (e) => {
    if (locations.value.length >= LOCATION_COUNT) return;
    if (pendingPin.value) return; // wait for hint confirmation
    const { lat, lng } = e.latlng;
    pendingPin.value = { lat, lng };
    pendingHint.value = "";
    // Show temporary marker
    if (tempMarker) tempMarker.remove();
    tempMarker = L.marker([lat, lng], { opacity: 0.6 }).addTo(leafletMap);
  });
});

onUnmounted(() => {
  leafletMap?.remove();
});

async function confirmPin() {
  if (!pendingPin.value) return;
  const L = await import("leaflet");
  const loc = { ...pendingPin.value, hint: pendingHint.value.trim() };
  locations.value.push(loc);

  // Replace temp with permanent numbered marker
  if (tempMarker) {
    tempMarker.remove();
    tempMarker = null;
  }
  const num = locations.value.length;
  const icon = L.divIcon({
    html: `<div class="loc-pin">${num}</div>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  const m = L.marker([loc.lat, loc.lng], { icon }).addTo(leafletMap);
  markers.push(m);

  pendingPin.value = null;
  pendingHint.value = "";
}

function cancelPin() {
  tempMarker?.remove();
  tempMarker = null;
  pendingPin.value = null;
  pendingHint.value = "";
}

function removeLocation(idx) {
  locations.value.splice(idx, 1);
  const m = markers.splice(idx, 1)[0];
  m?.remove();
  // Re-number remaining markers
  markers.forEach((marker, i) => {
    marker.setIcon(
      window.L?.divIcon({
        html: `<div class="loc-pin">${i + 1}</div>`,
        className: "",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    );
  });
}

async function save() {
  errorMsg.value = "";
  saving.value = true;
  try {
    const result = await setupLocationRecovery(locations.value);
    derivedMnemonic.value = result.mnemonic;
    recoveryCode.value = result.code;
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
.map {
  width: 100%;
  height: 300px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #ccc;
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

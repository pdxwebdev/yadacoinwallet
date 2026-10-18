<template>
  <div class="setup-view">
    <h1>Welcome to CA Career Passport</h1>
    <p class="intro">
      Your credential wallet generates a private key on this device. Your key
      never leaves your device.
    </p>

    <div v-if="!showMnemonic">
      <div class="section-title">Create a new wallet</div>
      <label class="field-label">Choose a PIN (6+ characters)</label>
      <input
        v-model="pin"
        type="password"
        inputmode="numeric"
        placeholder="PIN"
        class="input"
        autocomplete="new-password"
      />
      <input
        v-model="pinConfirm"
        type="password"
        inputmode="numeric"
        placeholder="Confirm PIN"
        class="input"
        autocomplete="new-password"
      />
      <p v-if="pinError" class="error">{{ pinError }}</p>
      <button class="btn-primary" :disabled="creating" @click="create">
        {{ creating ? "Creating…" : "Create Wallet" }}
      </button>

      <hr class="divider" />

      <div class="section-title">Restore from backup phrase</div>
      <textarea
        v-model="importPhrase"
        placeholder="Enter your 12-word backup phrase"
        class="input textarea"
        rows="3"
      />
      <input
        v-model="importPin"
        type="password"
        placeholder="Choose a PIN"
        class="input"
        autocomplete="new-password"
      />
      <p v-if="importError" class="error">{{ importError }}</p>
      <button class="btn-secondary" :disabled="importing" @click="restore">
        {{ importing ? "Restoring…" : "Restore Wallet" }}
      </button>

      <hr class="divider" />

      <div class="section-title">Create wallet from locations</div>
      <p class="intro" style="margin-bottom: 0.5rem">
        Your 3 map locations generate a zero-knowledge proof — no phrase to
        write down. Re-pin the same 3 locations on any device to recover.
      </p>
      <button class="btn-secondary" @click="showLocationCreate = true">
        Create from Locations
      </button>

      <hr class="divider" />

      <div class="section-title">Recover with location map</div>
      <p class="intro" style="margin-bottom: 0.5rem">
        If your wallet was created from locations, restore it by re-pinning your
        locations.
      </p>
      <button class="btn-secondary" @click="$emit('recover-locations')">
        Recover with Locations
      </button>
    </div>

    <!-- Mnemonic backup screen -->
    <div v-else-if="showMnemonic" class="mnemonic-screen">
      <h2>Back up your recovery phrase</h2>
      <p class="warn">
        Write these 12 words down and store them somewhere safe. If you lose
        your PIN or this device, this phrase is the only way to recover your
        wallet. Never share it with anyone.
      </p>
      <div class="mnemonic-grid">
        <span v-for="(word, i) in mnemonicWords" :key="i" class="mnemonic-word">
          <span class="word-num">{{ i + 1 }}</span> {{ word }}
        </span>
      </div>
      <button class="btn-primary" @click="confirm">
        I've written it down → Continue
      </button>
    </div>

    <!-- Location-based wallet creation -->
    <LocationRecoverySetupView
      v-else-if="showLocationCreate && !locationSetupResult"
      @setup-complete="onLocationSetupComplete"
      @skip="showLocationCreate = false"
    />

    <!-- PIN step after location setup -->
    <div v-else-if="locationSetupResult" class="pin-screen">
      <h2>Set your wallet PIN</h2>
      <p class="intro">
        Your wallet has been created from your locations. Set a PIN to protect
        it on this device.
      </p>
      <div class="recovery-code-reminder">
        <span class="code-reminder-label">Recovery Code</span>
        <span class="code-reminder-value">{{ locationSetupResult.code }}</span>
      </div>
      <label class="field-label">Choose a PIN (6+ characters)</label>
      <input
        v-model="locationPin"
        type="password"
        inputmode="numeric"
        placeholder="PIN"
        class="input"
        autocomplete="new-password"
      />
      <input
        v-model="locationPinConfirm"
        type="password"
        inputmode="numeric"
        placeholder="Confirm PIN"
        class="input"
        autocomplete="new-password"
      />
      <p v-if="locationPinError" class="error">{{ locationPinError }}</p>
      <button
        class="btn-primary"
        :disabled="creatingLocationWallet"
        @click="createLocationWallet"
      >
        {{ creatingLocationWallet ? "Creating…" : "Create Wallet" }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { useKeyVault } from "../composables/useKeyVault.js";
import LocationRecoverySetupView from "./LocationRecoverySetupView.vue";

const emit = defineEmits(["created", "recover-locations"]);
const vault = useKeyVault();

const pin = ref("");
const pinConfirm = ref("");
const pinError = ref("");
const creating = ref(false);
const showMnemonic = ref(false);
const mnemonic = ref("");
const mnemonicWords = computed(() => mnemonic.value.split(" "));

// Location-based wallet creation
const showLocationCreate = ref(false);
const locationSetupResult = ref(null); // {mnemonic, code} from LocationRecoverySetupView
const locationPin = ref("");
const locationPinConfirm = ref("");
const locationPinError = ref("");
const creatingLocationWallet = ref(false);

const importPhrase = ref("");
const importPin = ref("");
const importError = ref("");
const importing = ref(false);

async function create() {
  pinError.value = "";
  if (pin.value.length < 6) {
    pinError.value = "PIN must be at least 6 characters.";
    return;
  }
  if (pin.value !== pinConfirm.value) {
    pinError.value = "PINs don't match.";
    return;
  }
  creating.value = true;
  try {
    mnemonic.value = await vault.createWallet(pin.value);
    showMnemonic.value = true;
  } catch (e) {
    pinError.value = e.message;
  } finally {
    creating.value = false;
  }
}

async function restore() {
  importError.value = "";
  if (importPin.value.length < 6) {
    importError.value = "PIN must be at least 6 characters.";
    return;
  }
  importing.value = true;
  try {
    await vault.importMnemonic(importPhrase.value.trim(), importPin.value);
    emit("created");
  } catch (e) {
    importError.value = e.message;
  } finally {
    importing.value = false;
  }
}

function confirm() {
  emit("created");
}

function onLocationSetupComplete({ mnemonic: m, code }) {
  locationSetupResult.value = { mnemonic: m, code };
}

async function createLocationWallet() {
  locationPinError.value = "";
  if (locationPin.value.length < 6) {
    locationPinError.value = "PIN must be at least 6 characters.";
    return;
  }
  if (locationPin.value !== locationPinConfirm.value) {
    locationPinError.value = "PINs don't match.";
    return;
  }
  creatingLocationWallet.value = true;
  try {
    await vault.importMnemonic(
      locationSetupResult.value.mnemonic,
      locationPin.value,
    );
    emit("created");
  } catch (e) {
    locationPinError.value = e.message;
  } finally {
    creatingLocationWallet.value = false;
  }
}
</script>

<style scoped>
.setup-view {
  padding: 1.5rem 1rem;
}
h1 {
  font-size: 1.4rem;
  margin-bottom: 0.5rem;
}
.intro {
  color: #555;
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
  line-height: 1.5;
}
.section-title {
  font-weight: 600;
  margin-bottom: 0.5rem;
  font-size: 0.95rem;
}
.field-label {
  display: block;
  font-size: 0.85rem;
  color: #555;
  margin-bottom: 0.25rem;
}
.input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 1rem;
  margin-bottom: 0.75rem;
}
.textarea {
  resize: vertical;
}
.btn-primary,
.btn-secondary {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
  margin-top: 0.25rem;
}
.btn-primary {
  background: #1a1a2e;
  color: #fff;
}
.btn-secondary {
  background: #e5e5e5;
  color: #1a1a2e;
}
.divider {
  margin: 1.5rem 0;
  border: none;
  border-top: 1px solid #e5e5e5;
}
.error {
  color: #c00;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.mnemonic-screen h2 {
  margin-bottom: 0.75rem;
}
.warn {
  background: #fff3cd;
  border: 1px solid #ffc107;
  border-radius: 8px;
  padding: 0.75rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.5;
}
.mnemonic-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}
.mnemonic-word {
  background: #f5f5f5;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
  font-size: 0.9rem;
}
.word-num {
  color: #999;
  font-size: 0.75rem;
  margin-right: 0.25rem;
}
.btn-skip {
  width: 100%;
  padding: 0.5rem;
  background: none;
  border: none;
  color: #888;
  font-size: 0.85rem;
  text-decoration: underline;
  cursor: pointer;
  margin-top: 0.25rem;
}
.pin-screen {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.recovery-code-reminder {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: #fff8e1;
  border: 1px solid #f0a500;
  border-radius: 8px;
  padding: 0.6rem 0.85rem;
  margin-bottom: 0.5rem;
}
.code-reminder-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #a06000;
  white-space: nowrap;
}
.code-reminder-value {
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  font-family: monospace;
  color: #1a1a2e;
}
</style>

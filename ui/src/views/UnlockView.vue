<template>
  <div class="unlock-view">
    <div class="lock-icon">🔒</div>
    <h2>Enter your PIN</h2>
    <input
      v-model="pin"
      type="password"
      inputmode="numeric"
      placeholder="PIN"
      class="input"
      autocomplete="current-password"
      @keyup.enter="unlock"
    />
    <p v-if="error" class="error">{{ error }}</p>
    <button class="btn-primary" :disabled="loading" @click="unlock">
      {{ loading ? "Unlocking…" : "Unlock" }}
    </button>

    <!-- Biometric unlock — shown on native if available -->
    <button
      v-if="biometricAvailable"
      class="btn-biometric"
      :disabled="loading"
      @click="unlockBiometric"
    >
      {{ biometricLabel }}
    </button>

    <button class="btn-recover" @click="$emit('recover-locations')">
      Forgot PIN? Recover with locations
    </button>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useKeyVault } from "../composables/useKeyVault.js";

const emit = defineEmits(["unlocked", "recover-locations"]);
const vault = useKeyVault();
const pin = ref("");
const error = ref("");
const loading = ref(false);
const biometricAvailable = ref(false);
const biometricLabel = ref("Use Face ID / Touch ID");

onMounted(async () => {
  // Only attempt biometric check on native Capacitor platforms
  if (!window.Capacitor?.isNativePlatform()) return;
  try {
    const { BiometricAuth } =
      await import("@aparajita/capacitor-biometric-auth");
    const result = await BiometricAuth.checkBiometry();
    if (result.isAvailable) {
      biometricAvailable.value = true;
      // Use a friendlier label based on biometry type
      const t = result.biometryType;
      if (t === 1 || t === "faceId") biometricLabel.value = "Use Face ID";
      else if (t === 2 || t === "touchId" || t === "fingerprintAuthentication")
        biometricLabel.value = "Use Fingerprint";
    }
  } catch {
    // biometric not available — silently skip
  }
});

async function unlock() {
  error.value = "";
  loading.value = true;
  try {
    await vault.unlock(pin.value);
    emit("unlocked");
  } catch (e) {
    error.value = "Incorrect PIN. Please try again.";
  } finally {
    loading.value = false;
    pin.value = "";
  }
}

async function unlockBiometric() {
  error.value = "";
  loading.value = true;
  try {
    const { BiometricAuth } =
      await import("@aparajita/capacitor-biometric-auth");
    await BiometricAuth.authenticate({
      reason: "Unlock your CA Career Passport",
      cancelTitle: "Use PIN instead",
      allowDeviceCredential: false,
    });
    // Biometric passed — retrieve the stored PIN from secure storage and unlock
    const storedPin = await vault.getBiometricPin();
    if (!storedPin) {
      error.value =
        "No PIN stored for biometric. Please use your PIN once to enable it.";
      return;
    }
    await vault.unlock(storedPin);
    emit("unlocked");
  } catch (e) {
    error.value =
      e.code === "userCancel" ? "" : "Biometric failed. Use your PIN.";
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.unlock-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem 1.5rem;
  gap: 1rem;
}
.lock-icon {
  font-size: 3rem;
}
h2 {
  font-size: 1.2rem;
}
.input {
  width: 100%;
  max-width: 300px;
  padding: 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 1.2rem;
  text-align: center;
}
.btn-primary {
  width: 100%;
  max-width: 300px;
  padding: 0.75rem;
  background: #1a1a2e;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.btn-biometric {
  width: 100%;
  max-width: 300px;
  padding: 0.75rem;
  background: #f0f4ff;
  color: #1a1a2e;
  border: 1px solid #c0ccee;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.btn-biometric:disabled,
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.btn-recover {
  background: none;
  border: none;
  color: #888;
  font-size: 0.8rem;
  text-decoration: underline;
  cursor: pointer;
  margin-top: 0.25rem;
}
</style>

<style scoped>
.unlock-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem 1.5rem;
  gap: 1rem;
}
.lock-icon {
  font-size: 3rem;
}
h2 {
  font-size: 1.2rem;
}
.input {
  width: 100%;
  max-width: 300px;
  padding: 0.75rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 1.2rem;
  text-align: center;
}
.btn-primary {
  width: 100%;
  max-width: 300px;
  padding: 0.75rem;
  background: #1a1a2e;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.error {
  color: #c00;
  font-size: 0.85rem;
}
.btn-recover {
  background: none;
  border: none;
  color: #888;
  font-size: 0.8rem;
  text-decoration: underline;
  cursor: pointer;
  margin-top: 0.25rem;
}
</style>

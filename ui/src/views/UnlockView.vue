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
    <button class="btn-recover" @click="$emit('recover-locations')">
      Forgot PIN? Recover with locations
    </button>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useKeyVault } from "../composables/useKeyVault.js";

const emit = defineEmits(["unlocked", "recover-locations"]);
const vault = useKeyVault();
const pin = ref("");
const error = ref("");
const loading = ref(false);

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

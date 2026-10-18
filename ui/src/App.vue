<template>
  <div class="wallet-app">
    <!-- Locked / Setup -->
    <SetupView
      v-if="!isUnlocked && !hasVault && !locationRecovery"
      @created="onUnlocked"
      @recover-locations="locationRecovery = true"
    />
    <LocationRecoveryView
      v-else-if="!isUnlocked && locationRecovery"
      @recovered="onUnlocked"
      @cancel="locationRecovery = false"
    />
    <UnlockView
      v-else-if="!isUnlocked"
      @unlocked="onUnlocked"
      @recover-locations="locationRecovery = true"
    />

    <!-- Main wallet -->
    <template v-else>
      <header class="wallet-header">
        <span class="wallet-title">CA Career Passport</span>
        <span class="did-badge" :title="holderDid">{{ shortDid }}</span>
        <button class="lock-btn" @click="lock">Lock</button>
      </header>

      <nav class="wallet-nav">
        <button
          :class="{ active: view === 'credentials' }"
          @click="view = 'credentials'"
        >
          Credentials
        </button>
        <button
          :class="{ active: view === 'receive' }"
          @click="view = 'receive'"
        >
          Receive
        </button>
        <button
          :class="{ active: view === 'present' }"
          @click="view = 'present'"
        >
          Present
        </button>
        <button
          :class="{ active: view === 'settings' }"
          @click="view = 'settings'"
        >
          Settings
        </button>
      </nav>

      <main class="wallet-main">
        <CredentialListView v-if="view === 'credentials'" />
        <ReceiveView v-else-if="view === 'receive'" />
        <PresentView v-else-if="view === 'present'" />
        <SettingsView v-else-if="view === 'settings'" />
      </main>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useKeyVault } from "./composables/useKeyVault.js";
import SetupView from "./views/SetupView.vue";
import UnlockView from "./views/UnlockView.vue";
import CredentialListView from "./views/CredentialListView.vue";
import ReceiveView from "./views/ReceiveView.vue";
import PresentView from "./views/PresentView.vue";
import LocationRecoveryView from "./views/LocationRecoveryView.vue";
import SettingsView from "./views/SettingsView.vue";

const vault = useKeyVault();
const { isUnlocked, holderDid, lock, hasVault: hasVaultFn } = vault;

const hasVault = ref(false);
const view = ref("credentials");
const locationRecovery = ref(false);

const shortDid = computed(() => {
  const d = holderDid.value;
  if (!d) return "";
  return d.length > 24 ? `${d.slice(0, 12)}...${d.slice(-8)}` : d;
});

onMounted(async () => {
  hasVault.value = await hasVaultFn();
});

function onUnlocked() {
  hasVault.value = true;
  view.value = "credentials";
}
</script>

<style>
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f5f5;
  color: #1a1a2e;
  min-height: 100dvh;
}

.wallet-app {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.wallet-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  background: #1a1a2e;
  color: #fff;
}

.wallet-title {
  font-weight: 700;
  font-size: 1.1rem;
  flex: 1;
}

.did-badge {
  font-size: 0.65rem;
  background: rgba(255, 255, 255, 0.15);
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  cursor: default;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lock-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #fff;
  padding: 0.3rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}

.wallet-nav {
  display: flex;
  border-bottom: 1px solid #e5e5e5;
}

.wallet-nav button {
  flex: 1;
  padding: 0.75rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-size: 0.9rem;
  color: #666;
}

.wallet-nav button.active {
  border-bottom-color: #1a1a2e;
  color: #1a1a2e;
  font-weight: 600;
}

.wallet-main {
  flex: 1;
  padding: 1rem;
  overflow-y: auto;
}
</style>

<script setup lang="ts">
const offline = ref(false);

function updateNetworkStatus(): void {
  offline.value = !navigator.onLine;
}

onMounted(() => {
  updateNetworkStatus();
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
});

onBeforeUnmount(() => {
  window.removeEventListener("online", updateNetworkStatus);
  window.removeEventListener("offline", updateNetworkStatus);
});
</script>

<template>
  <p
    v-if="offline"
    class="m-0 bg-[#1a1a16] px-5 py-3 text-center text-sm text-white"
    role="status"
  >
    Jste offline. Informační stránky zůstávají dostupné, odeslání formulářů a
    nahrání modelu vyžaduje připojení.
  </p>
</template>

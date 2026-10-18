import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// CAPACITOR_BUILD=1 when building for native iOS/Android (npx cap sync)
const isCapacitor = process.env.CAPACITOR_BUILD === "1";

export default defineConfig({
  plugins: [
    vue(),
    // Disable PWA service worker for native Capacitor builds —
    // the app is served from the local filesystem, not a network origin.
    !isCapacitor &&
      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "CA Career Passport",
          short_name: "Career Passport",
          description:
            "California's learner-controlled verifiable credential wallet",
          theme_color: "#1a1a2e",
          background_color: "#ffffff",
          display: "standalone",
          start_url: "/wallet/",
          icons: [
            {
              src: "/wallet/icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/wallet/icon-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\/wallet\/api\/.*/,
              handler: "NetworkFirst",
              options: { cacheName: "wallet-api" },
            },
          ],
        },
      }),
  ].filter(Boolean),
  // Capacitor serves via file://, so base must be "./" (relative).
  // Web/PWA deployment uses "/wallet/" for the Tornado static handler.
  base: isCapacitor ? "./" : "/wallet/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Capacitor WebView on iOS 15+ / Android 9+ fully supports ES2020 (BigInt, optional chaining, etc.)
    target: "es2020",
  },
  server: {
    proxy: {
      "/wallet/api": "http://localhost:8005",
    },
  },
});

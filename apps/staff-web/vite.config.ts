import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The release version, shown in Settings and stamped into index.html. The release build
// passes the number it is about to tag; every other build - `npm run dev`, the tests, a
// local `npm run build` - says `dev`. Set here, before Vite collects its env, because an
// undefined VITE_* would leave the literal `%VITE_APP_VERSION%` in the served page.
process.env.VITE_APP_VERSION ||= "dev";

// The dev server proxies /api to the local FastAPI process, which is what lets the
// app call same-origin `/api/v1/...` in development exactly as it does in production
// behind the Firebase Hosting rewrite. Without it the API base URL would have to
// differ between environments, and CORS would apply locally but not in production —
// a difference that hides bugs until deploy day.
//
// No path rewrite: the backend already serves under /api/v1.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173, // matches SITE_URL and CORS_ORIGINS in apps/api/.env.example
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // MSW matches against absolute URLs, and the app calls a same-origin `/api/v1`.
    // Giving jsdom a real origin is what lets that relative path resolve to something
    // the interceptor can match, instead of failing as an invalid URL.
    environmentOptions: { jsdom: { url: "http://localhost:5173" } },
    // `e2e/` stays excluded although nothing writes there yet: an end-to-end runner is
    // deferred, not abandoned (BACKLOG.md §12), and leaving the exclusion in place means
    // adding one later cannot start by breaking this suite.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
  },
});

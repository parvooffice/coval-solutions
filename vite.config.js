import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    root: "app",
    publicDir: "../public",
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || ""),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(env.VITE_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""),
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      // Keep the browser's Host header so the API's same-origin check accepts POST/PATCH requests.
      proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});

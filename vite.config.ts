import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Phones only allow microphone access over HTTPS, so the dev server uses a self-signed cert.
export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
});

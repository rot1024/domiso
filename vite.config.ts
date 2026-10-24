import { configDefaults, defineConfig } from "vitest/config";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Phones only allow microphone access over HTTPS, so the dev server uses a self-signed cert.
export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
  // tmp/ holds local benchmarks, audio and a Python env; keep the dev server and tests out of it.
  server: { watch: { ignored: ["**/tmp/**"] } },
  test: { exclude: [...configDefaults.exclude, "tmp/**"] },
});

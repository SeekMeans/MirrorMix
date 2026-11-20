import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "client",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  test: {
    root: ".",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

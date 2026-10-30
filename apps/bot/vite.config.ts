import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    hookTimeout: 120_000,
    include: ["test/**/*.test.ts", "smoke/**/*.test.ts"],
    testTimeout: 60_000,
  },
});

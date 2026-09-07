import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "src/test-utils/obsidian-mock.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});

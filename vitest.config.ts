import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@resound/core": pkg("core"),
      "@resound/audio": pkg("audio"),
      "@resound/transcribers": pkg("transcribers"),
      "@resound/exporters": pkg("exporters"),
      "@resound/sinks": pkg("sinks"),
      "@resound/kujo": pkg("kujo")
    }
  },
  test: {
    globals: true,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node"
  }
});

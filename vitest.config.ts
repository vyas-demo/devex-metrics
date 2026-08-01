import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // build-pages tests spawn `node dist/build-pages.js` subprocesses; on a
    // loaded machine those regularly exceed the 5s default and flake.
    testTimeout: 20_000,
  },
});

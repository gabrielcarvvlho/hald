import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", lib: "src/lib.ts" },
    format: ["esm"],
    target: "node20",
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["better-sqlite3"],
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    dts: false,
    clean: false,
    sourcemap: true,
    external: ["better-sqlite3"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);

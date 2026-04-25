import { describe, it, expect } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ================================================================
// Vendor bundling regression test
// ================================================================
// The viz loads sigma + graphology from vendored UMD bundles in
// src/viz/public/assets/vendor/ rather than CDN. If those files get
// removed (git rm) or the package.json `files` glob stops including
// src/viz/public/, the viz silently breaks at runtime when shipped.
//
// This guards against that by asserting:
//   1. Both vendor bundles exist with reasonable sizes.
//   2. index.html references the local paths, not unpkg.
// ================================================================

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(__dirname, "..", "..");
const PUBLIC_DIR = join(ROOT, "src", "viz", "public");
const VENDOR_DIR = join(PUBLIC_DIR, "assets", "vendor");

describe("viz vendor bundling", () => {
  it("ships sigma.min.js with size > 100KB", () => {
    const path = join(VENDOR_DIR, "sigma.min.js");
    expect(existsSync(path), `Missing vendored sigma at ${path}`).toBe(true);
    const size = statSync(path).size;
    expect(size, `sigma.min.js is suspiciously small (${size} bytes)`).toBeGreaterThan(100_000);
  });

  it("ships graphology.umd.min.js with size > 50KB", () => {
    const path = join(VENDOR_DIR, "graphology.umd.min.js");
    expect(existsSync(path), `Missing vendored graphology at ${path}`).toBe(true);
    const size = statSync(path).size;
    expect(size, `graphology.umd.min.js is suspiciously small (${size} bytes)`).toBeGreaterThan(
      50_000,
    );
  });

  it("index.html references local vendor paths, not unpkg", () => {
    const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
    expect(html, "index.html still references unpkg.com").not.toMatch(/unpkg\.com/);
    expect(html).toContain("/assets/vendor/sigma.min.js");
    expect(html).toContain("/assets/vendor/graphology.umd.min.js");
  });
});

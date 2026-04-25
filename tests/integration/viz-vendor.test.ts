import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { startVizServer } from "../../src/viz/server.js";
import { openDatabase } from "../../src/store/db.js";
import { Store } from "../../src/store/queries.js";

// ================================================================
// Vendor bundling regression test
// ================================================================
// The viz loads sigma + graphology from vendored UMD bundles in
// src/viz/public/vendor/ rather than CDN. If those files get
// removed (git rm) or the package.json `files` glob stops including
// src/viz/public/, the viz silently breaks at runtime when shipped.
//
// IMPORTANT: file existence alone is not enough — the server's
// `/assets/` URL prefix gets stripped before joining to PUBLIC_DIR,
// so files at the wrong path on disk get 404s through the HTTP
// route. This test boots the actual server and fetches the assets
// over HTTP to catch routing bugs (caught a real one in this fix).
// ================================================================

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(__dirname, "..", "..");
const PUBLIC_DIR = join(ROOT, "src", "viz", "public");
const VENDOR_DIR = join(PUBLIC_DIR, "vendor");

describe("viz vendor bundling — disk", () => {
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

// ================================================================
// HTTP routing test — boots the actual viz server and fetches the
// assets over HTTP. Catches the kind of bug where files exist on
// disk but the URL → file mapping is wrong (saw this in 2026-04
// when assets/ vs vendor/ paths got desynced).
// ================================================================

describe("viz vendor bundling — HTTP routing", () => {
  let store: Store;
  let serverUrl = "";
  let port = 0;

  beforeAll(async () => {
    const db = openDatabase(":memory:");
    store = new Store(db);
    // Pick a high random port to avoid collisions with the CLI default.
    port = 35000 + Math.floor(Math.random() * 5000);
    await startVizServer({ store, port, open: false });
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    // Server has SIGINT handler; closing store + relying on test
    // process exit is enough for vitest. The listening socket is
    // released when vitest tears down.
    try {
      store.close();
    } catch {
      // ignore
    }
  });

  it("serves /assets/vendor/sigma.min.js with > 100KB body", async () => {
    const res = await fetch(`${serverUrl}/assets/vendor/sigma.min.js`);
    expect(res.status, "sigma.min.js should be served at /assets/vendor/").toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(100_000);
  });

  it("serves /assets/vendor/graphology.umd.min.js with > 50KB body", async () => {
    const res = await fetch(`${serverUrl}/assets/vendor/graphology.umd.min.js`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(50_000);
  });

  it("serves /assets/app.js (the module entry)", async () => {
    const res = await fetch(`${serverUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("import");
  });

  it("serves /assets/url-state.js (sibling ESM module)", async () => {
    const res = await fetch(`${serverUrl}/assets/url-state.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("parseHash");
  });

  it("serves index.html at /", async () => {
    const res = await fetch(`${serverUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/assets/vendor/sigma.min.js");
  });

  it("404s on unknown asset paths", async () => {
    const res = await fetch(`${serverUrl}/assets/nope.js`);
    expect(res.status).toBe(404);
  });
});

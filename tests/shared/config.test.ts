import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/shared/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  it("returns defaults when no overrides", () => {
    const config = loadConfig();

    expect(config.branch).toBe("HEAD");
    expect(config.commitsPerChunk).toBe(10);
    expect(config.maxChunkTokens).toBe(2000);
    expect(config.provider).toBe("auto");
    expect(config.maxConcurrency).toBe(5);
    expect(config.maxRetries).toBe(3);
    expect(config.entityResolutionThreshold).toBe(0.85);
    expect(config.communityResolutions).toEqual([0.5, 1.0, 2.0]);
    expect(config.minCommunitySize).toBe(3);
  });

  it("resolves repoPath to absolute", () => {
    const config = loadConfig({ repoPath: "." });
    expect(config.repoPath).toBe(resolve("."));
  });

  it("resolves storagePath relative to repoPath", () => {
    const config = loadConfig({ repoPath: "/tmp/test-repo" });
    expect(config.storagePath).toBe("/tmp/test-repo/.git-oracle");
  });

  it("applies explicit overrides over defaults", () => {
    const config = loadConfig({
      maxConcurrency: 10,
      provider: "anthropic",
      maxCommits: 500,
    });

    expect(config.maxConcurrency).toBe(10);
    expect(config.provider).toBe("anthropic");
    expect(config.maxCommits).toBe(500);
  });

  describe("environment variable overrides", () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of [
        "GIT_ORACLE_PROVIDER",
        "GIT_ORACLE_MODEL",
        "GIT_ORACLE_MAX_COMMITS",
        "GIT_ORACLE_MAX_CONCURRENCY",
      ]) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("reads provider from GIT_ORACLE_PROVIDER", () => {
      process.env.GIT_ORACLE_PROVIDER = "openai";
      const config = loadConfig();
      expect(config.provider).toBe("openai");
    });

    it("reads numeric values from env", () => {
      process.env.GIT_ORACLE_MAX_COMMITS = "1000";
      process.env.GIT_ORACLE_MAX_CONCURRENCY = "8";
      const config = loadConfig();
      expect(config.maxCommits).toBe(1000);
      expect(config.maxConcurrency).toBe(8);
    });

    it("explicit overrides beat env vars", () => {
      process.env.GIT_ORACLE_PROVIDER = "openai";
      const config = loadConfig({ provider: "google" });
      expect(config.provider).toBe("google");
    });
  });

  describe("config file loading", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `git-oracle-test-${Date.now()}`);
      mkdirSync(join(tmpDir, ".git-oracle"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads settings from .git-oracle/config.json", () => {
      writeFileSync(
        join(tmpDir, ".git-oracle", "config.json"),
        JSON.stringify({ commitsPerChunk: 20, maxChunkTokens: 3000 }),
      );

      const config = loadConfig({ repoPath: tmpDir });
      expect(config.commitsPerChunk).toBe(20);
      expect(config.maxChunkTokens).toBe(3000);
    });

    it("explicit overrides beat config file", () => {
      writeFileSync(
        join(tmpDir, ".git-oracle", "config.json"),
        JSON.stringify({ commitsPerChunk: 20 }),
      );

      const config = loadConfig({ repoPath: tmpDir, commitsPerChunk: 5 });
      expect(config.commitsPerChunk).toBe(5);
    });

    it("config file beats env vars", () => {
      // Save and set env var
      const saved = process.env.GIT_ORACLE_PROVIDER;
      process.env.GIT_ORACLE_PROVIDER = "openai";

      writeFileSync(
        join(tmpDir, ".git-oracle", "config.json"),
        JSON.stringify({ provider: "google" }),
      );

      const config = loadConfig({ repoPath: tmpDir });
      expect(config.provider).toBe("google"); // config.json wins over env var

      // Restore
      if (saved === undefined) {
        delete process.env.GIT_ORACLE_PROVIDER;
      } else {
        process.env.GIT_ORACLE_PROVIDER = saved;
      }
    });

    it("handles malformed config file gracefully", () => {
      writeFileSync(
        join(tmpDir, ".git-oracle", "config.json"),
        "not valid json {{{",
      );

      // Should not throw, just use defaults
      const config = loadConfig({ repoPath: tmpDir });
      expect(config.commitsPerChunk).toBe(10);
    });
  });

  describe("config validation", () => {
    it("rejects maxChunkTokens < 100", () => {
      expect(() => loadConfig({ maxChunkTokens: 50 })).toThrow(
        "maxChunkTokens must be >= 100",
      );
    });

    it("rejects maxConcurrency < 1", () => {
      expect(() => loadConfig({ maxConcurrency: 0 })).toThrow(
        "maxConcurrency must be >= 1",
      );
    });

    it("rejects minCommunitySize < 1", () => {
      expect(() => loadConfig({ minCommunitySize: 0 })).toThrow(
        "minCommunitySize must be >= 1",
      );
    });

    it("rejects entityResolutionThreshold out of [0, 1]", () => {
      expect(() =>
        loadConfig({ entityResolutionThreshold: -0.1 }),
      ).toThrow("entityResolutionThreshold must be between 0 and 1");

      expect(() =>
        loadConfig({ entityResolutionThreshold: 1.5 }),
      ).toThrow("entityResolutionThreshold must be between 0 and 1");
    });

    it("rejects empty communityResolutions", () => {
      expect(() => loadConfig({ communityResolutions: [] })).toThrow(
        "At least one community resolution is required",
      );
    });

    it("rejects negative maxRetries", () => {
      expect(() => loadConfig({ maxRetries: -1 })).toThrow(
        "maxRetries must be >= 0",
      );
    });

    it("accepts valid edge-case values", () => {
      expect(() =>
        loadConfig({
          maxChunkTokens: 100,
          maxConcurrency: 1,
          minCommunitySize: 1,
          entityResolutionThreshold: 0,
          maxRetries: 0,
        }),
      ).not.toThrow();

      expect(() =>
        loadConfig({ entityResolutionThreshold: 1 }),
      ).not.toThrow();
    });
  });
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GitOracleConfig } from "./types.js";
import { logger } from "./logger.js";

const defaults: GitOracleConfig = {
  repoPath: ".",
  branch: "HEAD",
  commitsPerChunk: 10,
  maxChunkTokens: 2000,
  provider: "auto",
  maxConcurrency: 5,
  maxRetries: 3,
  entityResolutionThreshold: 0.85,
  leidenResolutions: [0.5, 1.0, 2.0],
  minCommunitySize: 3,
  storagePath: ".git-oracle",
};

export function loadConfig(
  overrides: Partial<GitOracleConfig> = {},
): GitOracleConfig {
  // Priority (highest → lowest): CLI flags > config.json > env vars > defaults

  // 1. Start with defaults
  let config = { ...defaults };

  // 2. Apply env vars (beats defaults, but loses to config.json)
  applyEnvOverrides(config);

  // 3. Determine repo path for config file lookup
  //    CLI override > env var (already applied) > default
  const repoPath = resolve(overrides.repoPath ?? config.repoPath);

  // 4. Load config.json (beats env vars)
  const configFilePath = resolve(repoPath, ".git-oracle", "config.json");
  if (existsSync(configFilePath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configFilePath, "utf-8"));
      config = { ...config, ...fileConfig };
    } catch (err) {
      logger.warn("Failed to parse .git-oracle/config.json, using defaults", {
        error: String(err),
      });
    }
  }

  // 5. Apply CLI overrides (highest priority)
  config = { ...config, ...stripUndefined(overrides) };

  // 6. Resolve paths to absolute
  config.repoPath = resolve(config.repoPath);
  config.storagePath = resolve(config.repoPath, config.storagePath);

  // 7. Validate
  validateConfig(config);

  return config;
}

function validateConfig(config: GitOracleConfig): void {
  if (config.maxChunkTokens < 100) {
    throw new Error("maxChunkTokens must be >= 100");
  }
  if (config.maxConcurrency < 1) {
    throw new Error("maxConcurrency must be >= 1");
  }
  if (config.minCommunitySize < 1) {
    throw new Error("minCommunitySize must be >= 1");
  }
  if (config.entityResolutionThreshold < 0 || config.entityResolutionThreshold > 1) {
    throw new Error("entityResolutionThreshold must be between 0 and 1");
  }
  if (!config.leidenResolutions?.length) {
    throw new Error("At least one community resolution is required");
  }
  if (config.maxRetries < 0) {
    throw new Error("maxRetries must be >= 0");
  }
}

function applyEnvOverrides(config: GitOracleConfig): void {
  const env = process.env;

  if (env.GIT_ORACLE_REPO) config.repoPath = env.GIT_ORACLE_REPO;
  if (env.GIT_ORACLE_BRANCH) config.branch = env.GIT_ORACLE_BRANCH;
  if (env.GIT_ORACLE_PROVIDER) {
    config.provider = env.GIT_ORACLE_PROVIDER as GitOracleConfig["provider"];
  }
  if (env.GIT_ORACLE_MODEL) config.model = env.GIT_ORACLE_MODEL;
  if (env.GIT_ORACLE_BASE_URL) config.baseUrl = env.GIT_ORACLE_BASE_URL;
  if (env.GIT_ORACLE_STORAGE) config.storagePath = env.GIT_ORACLE_STORAGE;
  if (env.GIT_ORACLE_MAX_COMMITS) {
    config.maxCommits = parseInt(env.GIT_ORACLE_MAX_COMMITS, 10);
  }
  if (env.GIT_ORACLE_MAX_CONCURRENCY) {
    config.maxConcurrency = parseInt(env.GIT_ORACLE_MAX_CONCURRENCY, 10);
  }
}

/** Remove undefined keys so they don't override real values during spread. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HaldConfig } from "./types.js";
import { logger } from "./logger.js";

const defaults: HaldConfig = {
  repoPath: ".",
  branch: "HEAD",
  commitsPerChunk: 10,
  maxChunkTokens: 5000,
  maxDiffLines: 200,
  maxFilesShown: 50,
  maxMessageChars: 5000,
  provider: "auto",
  maxConcurrency: 5,
  maxRetries: 3,
  entityResolutionThreshold: 0.85,
  gleaningMinCommits: 8,
  gleaningMaxEntitiesRatio: 0.5,
  communityResolutions: [0.5, 1.0, 2.0],
  minCommunitySize: 3,
  parentLinkThreshold: 0.3,
  splitWarningThreshold: 0.7,
  summaryReuseThreshold: 0.7,
  storagePath: ".hald",
};

export function loadConfig(overrides: Partial<HaldConfig> = {}): HaldConfig {
  // Priority (highest → lowest): CLI flags > config.json > env vars > defaults

  // 1. Start with defaults
  let config = { ...defaults };

  // 2. Apply env vars (beats defaults, but loses to config.json)
  applyEnvOverrides(config);

  // 3. Determine repo path for config file lookup
  //    CLI override > env var (already applied) > default
  const repoPath = resolve(overrides.repoPath ?? config.repoPath);

  // 4. Load config.json (beats env vars)
  const configFilePath = resolve(repoPath, ".hald", "config.json");
  if (existsSync(configFilePath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configFilePath, "utf-8"));
      config = { ...config, ...fileConfig };
    } catch (err) {
      logger.warn("Failed to parse .hald/config.json, using defaults", {
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

function validateConfig(config: HaldConfig): void {
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
  if (!config.communityResolutions?.length) {
    throw new Error("At least one community resolution is required");
  }
  if (config.maxRetries < 0) {
    throw new Error("maxRetries must be >= 0");
  }
  if (config.commitsPerChunk < 1) {
    throw new Error("commitsPerChunk must be >= 1");
  }
  if (config.parentLinkThreshold < 0 || config.parentLinkThreshold > 1) {
    throw new Error("parentLinkThreshold must be between 0 and 1");
  }
  if (config.splitWarningThreshold < 0 || config.splitWarningThreshold > 1) {
    throw new Error("splitWarningThreshold must be between 0 and 1");
  }
  if (config.summaryReuseThreshold < 0 || config.summaryReuseThreshold > 1) {
    throw new Error("summaryReuseThreshold must be between 0 and 1");
  }
  if (config.maxDiffLines < 1) {
    throw new Error("maxDiffLines must be >= 1");
  }
  if (config.maxFilesShown < 1) {
    throw new Error("maxFilesShown must be >= 1");
  }
  if (config.maxMessageChars < 1) {
    throw new Error("maxMessageChars must be >= 1");
  }
  if (config.gleaningMinCommits < 1) {
    throw new Error("gleaningMinCommits must be >= 1");
  }
  if (config.gleaningMaxEntitiesRatio < 0 || config.gleaningMaxEntitiesRatio > 1) {
    throw new Error("gleaningMaxEntitiesRatio must be between 0 and 1");
  }
}

function applyEnvOverrides(config: HaldConfig): void {
  const env = process.env;

  if (env.HALD_REPO) config.repoPath = env.HALD_REPO;
  if (env.HALD_BRANCH) config.branch = env.HALD_BRANCH;
  if (env.HALD_PROVIDER) {
    config.provider = env.HALD_PROVIDER as HaldConfig["provider"];
  }
  if (env.HALD_MODEL) config.model = env.HALD_MODEL;
  if (env.HALD_BASE_URL) config.baseUrl = env.HALD_BASE_URL;
  if (env.HALD_STORAGE) config.storagePath = env.HALD_STORAGE;
  if (env.HALD_MAX_COMMITS) {
    config.maxCommits = parseInt(env.HALD_MAX_COMMITS, 10);
  }
  if (env.HALD_MAX_CONCURRENCY) {
    config.maxConcurrency = parseInt(env.HALD_MAX_CONCURRENCY, 10);
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

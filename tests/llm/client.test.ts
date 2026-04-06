import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectProvider, createClient, NoProviderError } from "../../src/llm/client.js";

describe("detectProvider", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all provider env vars + host-agent vars
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "CLAUDE_PLUGIN_ROOT",
      "CURSOR_PLUGIN_ROOT",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns null when no API key is set", () => {
    expect(detectProvider()).toBeNull();
  });

  it("detects Anthropic provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = detectProvider();
    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });
  });

  it("detects OpenAI provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const result = detectProvider();
    expect(result).toEqual({
      provider: "openai",
      apiKey: "sk-openai-test",
    });
  });

  it("detects Google provider via GOOGLE_API_KEY", () => {
    process.env.GOOGLE_API_KEY = "google-test";
    const result = detectProvider();
    expect(result).toEqual({
      provider: "google",
      apiKey: "google-test",
    });
  });

  it("detects Google provider via GEMINI_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gemini-test";
    const result = detectProvider();
    expect(result).toEqual({
      provider: "google",
      apiKey: "gemini-test",
    });
  });

  it("prioritizes Anthropic > OpenAI > Google without host agent", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic";
    process.env.OPENAI_API_KEY = "openai";
    process.env.GOOGLE_API_KEY = "google";

    const result = detectProvider();
    expect(result!.provider).toBe("anthropic");
  });

  it("falls back to OpenAI when Anthropic not set", () => {
    process.env.OPENAI_API_KEY = "openai";
    process.env.GOOGLE_API_KEY = "google";

    const result = detectProvider();
    expect(result!.provider).toBe("openai");
  });

  it("prefers OpenAI when CURSOR_PLUGIN_ROOT is set, even if Anthropic key exists", () => {
    process.env.CURSOR_PLUGIN_ROOT = "/some/path";
    process.env.ANTHROPIC_API_KEY = "anthropic";
    process.env.OPENAI_API_KEY = "openai";

    const result = detectProvider();
    expect(result!.provider).toBe("openai");
    expect(result!.apiKey).toBe("openai");
  });

  it("prefers Anthropic when CLAUDE_PLUGIN_ROOT is set", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/some/path";
    process.env.ANTHROPIC_API_KEY = "anthropic";
    process.env.OPENAI_API_KEY = "openai";

    const result = detectProvider();
    expect(result!.provider).toBe("anthropic");
    expect(result!.apiKey).toBe("anthropic");
  });

  it("falls back to priority order when host agent key is missing", () => {
    process.env.CURSOR_PLUGIN_ROOT = "/some/path";
    // No OPENAI_API_KEY set — Cursor hint can't be used
    process.env.ANTHROPIC_API_KEY = "anthropic";

    const result = detectProvider();
    expect(result!.provider).toBe("anthropic");
  });
});

describe("createClient", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
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

  it("throws NoProviderError when auto and no keys", async () => {
    await expect(createClient({ provider: "auto", maxRetries: 1 })).rejects.toThrow(
      NoProviderError,
    );
  });

  it("uses env var API key when provider is explicit but apiKey not passed", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";

    // Should NOT throw — it should pick up the env var
    const client = await createClient({
      provider: "anthropic",
      maxRetries: 1,
    });
    expect(client.provider).toBe("anthropic");
  });

  it("throws when explicit provider has no env var and no apiKey", async () => {
    // No OPENAI_API_KEY set
    await expect(createClient({ provider: "openai", maxRetries: 1 })).rejects.toThrow(
      NoProviderError,
    );
  });
});

describe("NoProviderError", () => {
  it("has correct name and message", () => {
    const error = new NoProviderError("test message");
    expect(error.name).toBe("NoProviderError");
    expect(error.message).toBe("test message");
    expect(error).toBeInstanceOf(Error);
  });
});

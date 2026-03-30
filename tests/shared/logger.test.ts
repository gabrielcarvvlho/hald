import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger, LogLevel } from "../../src/shared/logger.js";

describe("Logger", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  });

  it("logs info messages as JSON to stderr", () => {
    const log = new Logger(LogLevel.INFO);
    log.info("test message", { key: "value" });

    expect(output).toHaveLength(1);
    const entry = JSON.parse(output[0]!);
    expect(entry.level).toBe("INFO");
    expect(entry.message).toBe("test message");
    expect(entry.key).toBe("value");
    expect(entry.timestamp).toBeDefined();
  });

  it("respects log level — DEBUG hidden when level is INFO", () => {
    const log = new Logger(LogLevel.INFO);
    log.debug("should be hidden");
    log.info("should appear");

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!).message).toBe("should appear");
  });

  it("shows DEBUG when level is DEBUG", () => {
    const log = new Logger(LogLevel.DEBUG);
    log.debug("visible");

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!).message).toBe("visible");
  });

  it("SILENT suppresses all output", () => {
    const log = new Logger(LogLevel.SILENT);
    log.debug("hidden");
    log.info("hidden");
    log.warn("hidden");
    log.error("hidden");

    expect(output).toHaveLength(0);
  });

  it("logs all levels correctly", () => {
    const log = new Logger(LogLevel.DEBUG);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(output).toHaveLength(4);
    expect(JSON.parse(output[0]!).level).toBe("DEBUG");
    expect(JSON.parse(output[1]!).level).toBe("INFO");
    expect(JSON.parse(output[2]!).level).toBe("WARN");
    expect(JSON.parse(output[3]!).level).toBe("ERROR");
  });

  it("time() measures duration", async () => {
    const log = new Logger(LogLevel.INFO);
    const stop = log.time("operation");

    // Small delay to ensure measurable duration
    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(output).toHaveLength(1);
    const entry = JSON.parse(output[0]!);
    expect(entry.message).toBe("operation");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("setLevel changes level dynamically", () => {
    const log = new Logger(LogLevel.ERROR);
    log.info("hidden");
    expect(output).toHaveLength(0);

    log.setLevel(LogLevel.INFO);
    log.info("visible");
    expect(output).toHaveLength(1);
  });
});

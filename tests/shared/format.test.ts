import { describe, it, expect } from "vitest";
import { formatNumber } from "../../src/shared/format.js";

// ================================================================
// formatNumber — deterministic, locale-independent thousands grouping
//
// Regression guard: the platform default `Number.prototype.toLocaleString()`
// renders '12.345' on pt_BR/de_DE but '12,345' on en-US, which made CLI output
// (and tests) machine-dependent. formatNumber must always use comma grouping.
// ================================================================

describe("formatNumber", () => {
  it("leaves small integers (< 1000) ungrouped", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(7)).toBe("7");
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(999)).toBe("999");
  });

  it("groups thousands with a comma regardless of locale", () => {
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(12345)).toBe("12,345");
    expect(formatNumber(6789)).toBe("6,789");
  });

  it("groups large numbers (millions and billions)", () => {
    expect(formatNumber(1_000_000)).toBe("1,000,000");
    expect(formatNumber(1_234_567)).toBe("1,234,567");
    expect(formatNumber(1_000_000_000)).toBe("1,000,000,000");
  });

  it("handles negative numbers", () => {
    expect(formatNumber(-1)).toBe("-1");
    expect(formatNumber(-12345)).toBe("-12,345");
    expect(formatNumber(-1_234_567)).toBe("-1,234,567");
  });

  it("handles zero (including negative zero)", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
  });

  it("truncates fractional input to an integer before grouping", () => {
    expect(formatNumber(12345.99)).toBe("12,345");
    expect(formatNumber(-12345.99)).toBe("-12,345");
  });

  it("renders non-finite input gracefully without throwing", () => {
    expect(formatNumber(NaN)).toBe("0");
    expect(formatNumber(Infinity)).toBe("0");
    expect(formatNumber(-Infinity)).toBe("0");
  });
});

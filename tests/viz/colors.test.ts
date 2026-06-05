import { describe, it, expect } from "vitest";
// @ts-expect-error — browser ESM module, no .d.ts; runtime-importable in Node.
import {
  hexToRgba,
  edgeAlphaFor,
  edgeColorFor,
  edgeSizeFor,
  getColors,
  setColors,
  COLORS_LIGHT,
  COLORS_DARK,
} from "../../src/viz/public/colors.js";
// @ts-expect-error — browser ESM module, no .d.ts.
import { thresholdForRatio } from "../../src/viz/public/zoom-density.js";
// @ts-expect-error — browser ESM module, no .d.ts.
import { smoothstep, strHash } from "../../src/viz/public/motion-math.js";

describe("hexToRgba", () => {
  it("expands 3-digit hex", () => {
    expect(hexToRgba("#abc", 0.5)).toBe("rgba(170,187,204,0.5)");
  });

  it("parses 6-digit hex", () => {
    expect(hexToRgba("#3b82f6", 0.2)).toBe("rgba(59,130,246,0.2)");
  });

  it("tolerates missing leading #", () => {
    expect(hexToRgba("10b981", 1)).toBe("rgba(16,185,129,1)");
  });

  it("falls back to slate-400 on garbage input", () => {
    expect(hexToRgba("not-a-color", 0.3)).toBe("rgba(148,163,184,0.3)");
    expect(hexToRgba("#12", 0.3)).toBe("rgba(148,163,184,0.3)");
    // @ts-expect-error — intentionally wrong type
    expect(hexToRgba(null, 0.3)).toBe("rgba(148,163,184,0.3)");
  });
});

describe("edgeAlphaFor", () => {
  it("intra edges start brighter than cross edges at weight 1", () => {
    const intra = edgeAlphaFor(1, false);
    const cross = edgeAlphaFor(1, true);
    expect(intra).toBeGreaterThan(cross);
    // base 0.42 + log(2)*0.12 ≈ 0.5032
    expect(intra).toBeCloseTo(0.42 + Math.log(2) * 0.12, 6);
    // base 0.16 + log(2)*0.12 ≈ 0.2432
    expect(cross).toBeCloseTo(0.16 + Math.log(2) * 0.12, 6);
  });

  it("rises monotonically with weight then plateaus under the 0.88 ceiling", () => {
    expect(edgeAlphaFor(1, false)).toBeLessThan(edgeAlphaFor(30, false));
    // The boost is capped at min(0.42, ...) BEFORE the outer min(0.88, ...),
    // so intra alpha plateaus at base 0.42 + boost 0.42 = 0.84 — the 0.88
    // ceiling is never actually reached.
    expect(edgeAlphaFor(100000, false)).toBeLessThanOrEqual(0.88);
    expect(edgeAlphaFor(100000, false)).toBeCloseTo(0.84, 6);
  });

  it("treats missing weight as 1", () => {
    expect(edgeAlphaFor(undefined, false)).toBe(edgeAlphaFor(1, false));
  });
});

describe("edgeColorFor", () => {
  it("uses the intra RGB tuple for non-cross edges", () => {
    const c = edgeColorFor(1, false, COLORS_LIGHT);
    const a = edgeAlphaFor(1, false).toFixed(3);
    expect(c).toBe(`rgba(100,116,139,${a})`);
  });

  it("uses the cross RGB tuple for cross edges", () => {
    const c = edgeColorFor(1, true, COLORS_LIGHT);
    const a = edgeAlphaFor(1, true).toFixed(3);
    expect(c).toBe(`rgba(148,163,184,${a})`);
  });

  it("reads RGB from the passed palette (dark differs from light)", () => {
    const light = edgeColorFor(5, false, COLORS_LIGHT);
    const dark = edgeColorFor(5, false, COLORS_DARK);
    expect(light).not.toBe(dark);
  });
});

describe("edgeSizeFor", () => {
  it("returns the thin floor for weight 1", () => {
    // 0.5 + min(2.5, log(2)*0.7) ≈ 0.985
    expect(edgeSizeFor(1)).toBeCloseTo(0.5 + Math.log(2) * 0.7, 6);
  });

  it("scales up with weight and caps at 3.0", () => {
    expect(edgeSizeFor(1)).toBeLessThan(edgeSizeFor(30));
    expect(edgeSizeFor(1e9)).toBeCloseTo(3.0, 6);
  });

  it("treats missing weight as 1", () => {
    expect(edgeSizeFor(undefined)).toBe(edgeSizeFor(1));
  });
});

describe("getColors / setColors", () => {
  it("defaults to the light palette and swaps on setColors", () => {
    // Default is light.
    expect(getColors()).toBe(COLORS_LIGHT);
    setColors(COLORS_DARK);
    expect(getColors()).toBe(COLORS_DARK);
    // Restore so test order independence holds.
    setColors(COLORS_LIGHT);
    expect(getColors()).toBe(COLORS_LIGHT);
  });
});

describe("thresholdForRatio", () => {
  it("returns the first bucket whose maxRatio the ratio is below", () => {
    expect(thresholdForRatio(0.1)).toBe(3); // < 0.35
    expect(thresholdForRatio(0.4)).toBe(6); // < 0.55
    expect(thresholdForRatio(0.7)).toBe(9); // < 0.85
    expect(thresholdForRatio(1.0)).toBe(12); // < 1.30 (default zoom)
    expect(thresholdForRatio(1.5)).toBe(20); // < 2.00
    expect(thresholdForRatio(5.0)).toBe(999); // far out — communities only
  });

  it("uses strict less-than at bucket boundaries", () => {
    // ratio exactly 0.35 is NOT < 0.35, so it falls to the next bucket.
    expect(thresholdForRatio(0.35)).toBe(6);
  });
});

describe("motion-math", () => {
  it("smoothstep clamps and eases", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
  });

  it("strHash is deterministic and non-negative", () => {
    const a = strHash("src/extractor.ts");
    const b = strHash("src/extractor.ts");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(strHash("a")).not.toBe(strHash("b"));
  });
});

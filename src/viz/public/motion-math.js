// ================================================================
// Motion math — pure easing + hashing helpers
// ================================================================
// Extracted so the curve math is importable in Node (vitest) with no
// DOM/window/Sigma dependency. The stateful breathing/ripple loop
// lives in motion.js and imports these.

export function smoothstep(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

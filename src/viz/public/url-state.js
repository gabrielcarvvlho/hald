// ================================================================
// URL state (#node=abc&hide=PERSON,MODULE)
//
// Pure ESM module — no DOM access — so it imports cleanly from both
// the browser app.js and the vitest test suite.
//
// Per /plan-eng-review C6: skip camera state. The hash is for
// "share this view of the graph" not "reproduce my pixel-exact
// camera position." Layout reseats automatically.
// ================================================================

/**
 * Parse a URL hash into structured state.
 *
 * Handles:
 *   ""                                 → { hide: [] }
 *   "#"                                → { hide: [] }
 *   "#node=abc"                        → { node: "abc", hide: [] }
 *   "#hide=PERSON,MODULE"              → { hide: ["PERSON","MODULE"] }
 *   "#node=abc&hide=PERSON"            → { node: "abc", hide: ["PERSON"] }
 *   "#node=module%3Aauth"              → { node: "module:auth", hide: [] }
 *   "#garbage&%bad&node=ok"            → { node: "ok", hide: [] }
 *
 * Never throws. Malformed parts are skipped, valid ones survive.
 */
export function parseHash(hash) {
  const out = { hide: [] };
  if (!hash || typeof hash !== "string") return out;
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!cleaned) return out;

  for (const part of cleaned.split("&")) {
    if (!part) continue;
    try {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = decodeURIComponent(part.slice(0, eq));
      const val = decodeURIComponent(part.slice(eq + 1));
      if (key === "node" && val) {
        out.node = val;
      } else if (key === "hide" && val) {
        out.hide = val.split(",").filter(Boolean);
      }
    } catch (_e) {
      // Skip malformed pair, keep going.
    }
  }
  return out;
}

/**
 * Serialize state into a URL hash payload (no leading "#").
 *
 * Returns "" for empty/default state — caller can decide whether to
 * write a bare "#" or strip the fragment entirely.
 */
export function serializeState(state) {
  if (!state || typeof state !== "object") return "";
  const parts = [];
  if (state.node) {
    parts.push("node=" + encodeURIComponent(state.node));
  }
  if (Array.isArray(state.hide) && state.hide.length > 0) {
    parts.push("hide=" + state.hide.map(encodeURIComponent).join(","));
  }
  return parts.join("&");
}

// ================================================================
// Motion — P1.A breathing + P1.B hover ripple
// ================================================================
// Two effects share one requestAnimationFrame loop:
//
//   1. Breathing: each real node oscillates around its FA2-computed
//      baseline using uncorrelated sine waves. Per-node phase and
//      frequency come from a hash of the node id, so motion is
//      deterministic across reloads (good for screenshots/UX) and
//      uncorrelated across the cluster (no synchronized pulsing).
//
//   2. Ripple: when the user hovers a node, its neighbors briefly
//      pulse (size grows then returns) on a smoothstep curve. The
//      pulse map is read in nodeReducer; the loop drives refresh.
//
// Why sin oscillation instead of continuous ForceAtlas2: FA2 in the
// browser would need a worker bundle of the graphology layout pkg
// in vendor/. Sine drift gets the "alive" feel for free, can't
// destroy the layout (always returns to baseline), and costs ~0ms
// for 200 nodes per tick.
//
// `prefers-reduced-motion: reduce` disables breathing AND ripple
// entirely — accessibility takes precedence over polish.

import { state, prefersReducedMotion } from "./state.js";
import { smoothstep, strHash } from "./motion-math.js";
import { HALO_PREFIX, isHalo } from "./halo.js";

const MOTION_AMP = 1.2;            // graph units; layout scale ≈ 100 → ~1.2% drift
const MOTION_PULSE_MS = 360;       // total ripple duration
const MOTION_PULSE_PEAK = 0.18;    // size multiplier add at peak (1.0 → 1.18 → 1.0)
const MOTION_PULSE_RETRIGGER = 0.6; // ignore re-pulses on a node within 60% of duration

// ================================================================
// Motion init + loop
// ================================================================
//
// initMotion() runs after halos are added. It snapshots each real
// node's baseline position and assigns deterministic per-node phase
// + frequency + amplitude from the node id's hash. With independent
// sin oscillators per node, the cluster wanders organically without
// synchronized pulsing.

export function initMotion(graph) {
  state.motion.baselines.clear();
  state.motion.phases.clear();
  state.motion.pulses.clear();
  graph.forEachNode((id, attrs) => {
    if (isHalo(id)) return;
    state.motion.baselines.set(id, { x: attrs.x, y: attrs.y });
    const h = strHash(id);
    state.motion.phases.set(id, {
      // Frequencies in 0.18–0.40 rad/sec → periods 16–35 sec. Slow
      // enough to read as "alive", not as "panning".
      fx: 0.18 + ((h & 0xff) / 0xff) * 0.22,
      fy: 0.18 + (((h >> 8) & 0xff) / 0xff) * 0.22,
      phx: (((h >> 16) & 0xff) / 0xff) * Math.PI * 2,
      phy: (((h >> 24) & 0xff) / 0xff) * Math.PI * 2,
      // Amplitude jitter so neighbors don't trace identical orbits.
      ax: 0.7 + ((h & 0xf) / 0xf) * 0.6,
      ay: 0.7 + (((h >> 4) & 0xf) / 0xf) * 0.6,
    });
  });
}

export function startMotionLoop() {
  if (state.motion.enabled) return;
  // Honor accessibility preference. With reduced motion, neither
  // breathing nor ripple ever fires — sigma renders on demand only.
  if (prefersReducedMotion()) {
    state.motion.enabled = false;
    return;
  }
  state.motion.enabled = true;

  const tick = (nowMs) => {
    if (!state.renderer || !state.graph) {
      state.motion.rafId = requestAnimationFrame(tick);
      return;
    }
    const t = nowMs / 1000;
    const g = state.graph;

    // Breathing — drift each real node + co-located halo.
    state.motion.baselines.forEach((origin, id) => {
      if (!g.hasNode(id)) return;
      const ph = state.motion.phases.get(id);
      if (!ph) return;
      const dx = MOTION_AMP * ph.ax * Math.sin(t * ph.fx + ph.phx);
      const dy = MOTION_AMP * ph.ay * Math.sin(t * ph.fy + ph.phy);
      const x = origin.x + dx;
      const y = origin.y + dy;
      g.setNodeAttribute(id, "x", x);
      g.setNodeAttribute(id, "y", y);
      const haloId = HALO_PREFIX + id;
      if (g.hasNode(haloId)) {
        g.setNodeAttribute(haloId, "x", x);
        g.setNodeAttribute(haloId, "y", y);
      }
    });

    // Sweep stale pulses so the map stays small over long sessions.
    state.motion.pulses.forEach((startMs, id) => {
      if (nowMs - startMs > MOTION_PULSE_MS) {
        state.motion.pulses.delete(id);
      }
    });

    state.renderer.refresh();
    state.motion.rafId = requestAnimationFrame(tick);
  };
  state.motion.rafId = requestAnimationFrame(tick);
}

// Trigger ripple on neighbors of a node. Re-trigger guard: if a
// pulse is still in its early phase, leave it alone — replaying
// from start mid-curve produces a visible stutter.
export function triggerRipple(realId) {
  if (!state.motion.enabled) return;
  const neighbors = state.neighbors.get(realId);
  if (!neighbors) return;
  const now = performance.now();
  neighbors.forEach((nid) => {
    const existing = state.motion.pulses.get(nid);
    if (!existing || now - existing > MOTION_PULSE_MS * MOTION_PULSE_RETRIGGER) {
      state.motion.pulses.set(nid, now);
    }
  });
}

// Pulse multiplier for nodeReducer. Returns 1.0 when the node is
// not pulsing. Triangle-shaped curve (rises then falls) eased with
// smoothstep so the peak doesn't feel like a corner.
export function pulseSizeMult(realId, nowMs) {
  const start = state.motion.pulses.get(realId);
  if (start === undefined) return 1;
  const t = (nowMs - start) / MOTION_PULSE_MS;
  if (t <= 0 || t >= 1) return 1;
  const wave = t < 0.5 ? smoothstep(t * 2) : smoothstep((1 - t) * 2);
  return 1 + MOTION_PULSE_PEAK * wave;
}

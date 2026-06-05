// ================================================================
// Legend — compact, collapsible corner panel that decodes the
// visual language of the graph so a first-time viewer can read it:
//   node color  = community (cluster)
//   node size   = how often the entity appears (frequency)
//   edge weight = relationship strength
//   toolbar chips encode entity TYPE
//
// The markup lives in index.html (#legend); this module only wires
// the collapse toggle and persists the open/closed state so the
// panel respects the viewer's last choice. Pure DOM — no WebGL.
// ================================================================

const LEGEND_KEY = "hald-legend-open";

export function setupLegend() {
  const legend = document.getElementById("legend");
  if (!legend) return;
  const toggle = document.getElementById("legend-toggle");
  if (!toggle) return;

  // Default to open on first visit so the encoding is explained
  // up front; collapse is a deliberate, remembered choice.
  let open = true;
  try {
    const stored = localStorage.getItem(LEGEND_KEY);
    if (stored === "closed") open = false;
  } catch (_e) {
    // localStorage may be blocked in some contexts; ignore.
  }

  function apply(isOpen) {
    legend.classList.toggle("is-collapsed", !isOpen);
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.setAttribute(
      "aria-label",
      isOpen ? "Collapse legend" : "Expand legend",
    );
  }

  apply(open);

  toggle.addEventListener("click", () => {
    open = !open;
    apply(open);
    try {
      localStorage.setItem(LEGEND_KEY, open ? "open" : "closed");
    } catch (_e) {
      // ignore
    }
  });
}

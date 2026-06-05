// ================================================================
// URL state sync — debounced writes to history.replaceState so
// rapid filter toggles or search keystrokes don't spam the address
// bar (per /plan-eng-review P1, 200ms matches the search debounce).
// ================================================================

import { state } from "./state.js";
import { serializeState } from "./url-state.js";

let urlUpdateTimer = null;

export function scheduleUrlUpdate() {
  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);
  urlUpdateTimer = setTimeout(writeUrl, 200);
}

function writeUrl() {
  urlUpdateTimer = null;
  const payload = serializeState({
    node: state.selectedNode,
    hide: Array.from(state.hiddenTypes),
  });
  const url = payload
    ? window.location.pathname + window.location.search + "#" + payload
    : window.location.pathname + window.location.search;
  history.replaceState(null, "", url);
}

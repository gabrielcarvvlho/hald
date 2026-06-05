// ================================================================
// Shortcuts — discoverability for the graph's gestures, which are
// otherwise invisible. Two surfaces:
//
//   1. A header "?" button that toggles a popover listing every
//      gesture / keyboard shortcut (path trace, cluster explain,
//      "/" search, arrow-key pan, Esc).
//   2. A one-time, dismissible first-run hint floating near the
//      canvas that summarizes the top three gestures. Dismissal is
//      remembered so returning viewers never see it again.
//
// Both surfaces are built in index.html; this module only wires the
// open/close behavior and the first-run persistence. Pure DOM.
// ================================================================

const HINT_KEY = "hald-firstrun-dismissed";

export function setupShortcuts() {
  setupPopover();
  setupFirstRunHint();
}

// ----------------------------------------------------------------
// "?" popover
// ----------------------------------------------------------------

function setupPopover() {
  const btn = document.getElementById("btn-help");
  const popover = document.getElementById("shortcuts-popover");
  if (!btn || !popover) return;

  function open() {
    popover.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  }
  function close() {
    popover.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
  function toggle() {
    if (popover.hidden) open();
    else close();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  const closeBtn = popover.querySelector(".shortcuts-popover-close");
  if (closeBtn) closeBtn.addEventListener("click", close);

  // Dismiss on outside click or Escape — standard popover ergonomics.
  // The popover's own clicks are stopped so they don't bubble to the
  // document handler and immediately close it.
  popover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (!popover.hidden) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) close();
  });
}

// ----------------------------------------------------------------
// First-run hint
// ----------------------------------------------------------------

function setupFirstRunHint() {
  const hint = document.getElementById("firstrun-hint");
  if (!hint) return;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(HINT_KEY) === "true";
  } catch (_e) {
    // localStorage may be blocked; treat as not-dismissed.
  }

  if (dismissed) {
    hint.remove();
    return;
  }

  hint.hidden = false;

  function dismiss() {
    hint.remove();
    try {
      localStorage.setItem(HINT_KEY, "true");
    } catch (_e) {
      // ignore
    }
  }

  const closeBtn = hint.querySelector(".firstrun-hint-close");
  if (closeBtn) closeBtn.addEventListener("click", dismiss);
}

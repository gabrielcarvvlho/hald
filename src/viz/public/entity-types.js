// ================================================================
// Entity type visual language
// ================================================================
// Community owns color in the graph. Entity type is represented with
// compact neutral text badges so it stays legible without competing
// with community hues.

export const ENTITY_TYPE_MARKS = {
  PERSON: "PE",
  MODULE: "MO",
  TECHNOLOGY: "TE",
  DECISION: "DE",
  PATTERN: "PA",
  CONCEPT: "CO",
  RISK: "RI",
  PROCESS: "PR",
};

export function normalizeEntityType(type) {
  return String(type || "").trim().toUpperCase();
}

export function entityTypeLabel(type) {
  const normalized = normalizeEntityType(type);
  if (!normalized) return "Unknown";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export function entityTypeMark(type) {
  const normalized = normalizeEntityType(type);
  if (!normalized) return "--";
  if (ENTITY_TYPE_MARKS[normalized]) return ENTITY_TYPE_MARKS[normalized];
  return normalized.replace(/[^A-Z0-9]/g, "").slice(0, 2).padEnd(2, "-");
}

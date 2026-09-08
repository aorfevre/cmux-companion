// The three questions the goal form asks, mapped to the delivery contract: the
// goal text is the outcome, `exclusions` are what must not change, and
// `verification` is how the user will know it worked. Browser-safe and
// data-only, so the form and the server normalize the same way.
const MAX_ITEMS = 12;
const MAX_ITEM_TEXT = 500;
export const MAX_INTAKE_FIELD_TEXT = 4_000;

export const EMPTY_INTAKE = Object.freeze({ exclusions: Object.freeze([]), verification: Object.freeze([]) });

// Accepts a newline-separated string or a list for each field. Blank lines are
// dropped; an oversized answer is refused rather than silently cut, because a
// cut exclusion is a changed requirement.
export function normalizeIntake(value) {
  if (value === undefined || value === null) return { exclusions: [], verification: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid goal intake");
  return { exclusions: lines(value.exclusions, "exclusions"), verification: lines(value.verification, "verification") };
}

export function hasIntake(intake) {
  return Boolean(intake && ((intake.exclusions || []).length || (intake.verification || []).length));
}

// The prompt block for the discovery agent. The answers are the user's
// requirements, so the agent confirms them instead of inventing its own.
export function intakePromptLines(intake) {
  if (!hasIntake(intake)) return [];
  const block = ["The user answered the goal intake. Confirm these with the user before you publish; do not drop or reword them without asking."];
  if (intake.exclusions.length) block.push("What must not change:", ...intake.exclusions.map((item) => `- ${item}`));
  if (intake.verification.length) block.push("How the user will know it worked:", ...intake.verification.map((item) => `- ${item}`));
  return block;
}

function lines(value, field) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null;
  if (raw === null) throw new TypeError(`Invalid goal intake ${field}`);
  if (raw.join("\n").length > MAX_INTAKE_FIELD_TEXT) throw new TypeError(`Goal intake ${field} is too long`);
  const items = raw.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (items.length > MAX_ITEMS) throw new TypeError(`Goal intake ${field} has too many lines`);
  return items.map((item) => item.slice(0, MAX_ITEM_TEXT));
}

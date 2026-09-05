// This catalog is deliberately data-only: the client sheet and the server
// validator both consume it, so a model cannot be offered in the UI without
// also being allowed at the process boundary. The reviewer policy lives here
// too, rather than drifting between the label and the spawned command.
export const PLANNER_ENGINES = Object.freeze({
  defaultProvider: "claude",
  defaultModel: "default",
  defaultEffort: "default",
  efforts: Object.freeze([
    Object.freeze({ id: "default", label: "Default" }),
    Object.freeze({ id: "low", label: "Low" }),
    Object.freeze({ id: "medium", label: "Medium" }),
    Object.freeze({ id: "high", label: "High" }),
    Object.freeze({ id: "xhigh", label: "Xhigh" }),
  ]),
  reviewerEffort: "xhigh",
  providers: Object.freeze({
    claude: Object.freeze({
      label: "Claude Code",
      family: "xclaude",
      largestModel: "claude-fable-5-1",
      models: Object.freeze([
        Object.freeze({ id: "default", label: "Default" }),
        Object.freeze({ id: "claude-opus-5", label: "Opus 5" }),
        Object.freeze({ id: "claude-fable-5-1", label: "Fable 5.1" }),
      ]),
    }),
    codex: Object.freeze({
      label: "Codex",
      family: "xcodex",
      largestModel: "gpt-5.6-sol",
      models: Object.freeze([
        Object.freeze({ id: "default", label: "Default" }),
        Object.freeze({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }),
        Object.freeze({ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }),
        Object.freeze({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
      ]),
    }),
  }),
});

export function reviewerEngine(provider) {
  if (provider !== "claude" && provider !== "codex") throw new TypeError("Unknown planner provider. Choose Claude or Codex");
  const reviewerProvider = provider === "claude" ? "codex" : "claude";
  return {
    provider: reviewerProvider,
    model: PLANNER_ENGINES.providers[reviewerProvider].largestModel,
    effort: PLANNER_ENGINES.reviewerEffort,
    reviewer: false,
  };
}

// The six specification-rigor requests share this catalog for the same reason
// as the engines above: the planner sheet, the prompt builders and the
// contract validator must agree on the exact ids, order and wording. The
// entries stay data-only so the browser bundle can import them.
export const SPEC_OPTIONS = Object.freeze({
  options: Object.freeze([
    Object.freeze({ id: "unitTests", label: "Unit tests", hint: "Cover the new logic with unit tests." }),
    Object.freeze({ id: "e2eTests", label: "End-to-end tests", hint: "Cover the user-visible flow with end-to-end tests." }),
    Object.freeze({ id: "edgeCases", label: "Edge cases", hint: "Name the edge cases and cover each one." }),
    Object.freeze({ id: "refactorPass", label: "Refactor review", hint: "Add a refactor task that reviews and cleans the touched code." }),
    Object.freeze({ id: "screenMocks", label: "Screen wireframes", hint: "Return a screen wireframe for each new or changed screen." }),
    Object.freeze({ id: "flowcharts", label: "Flowcharts", hint: "Return a flowchart for each new or changed flow." }),
  ]),
  defaults: Object.freeze({
    unitTests: false,
    e2eTests: false,
    edgeCases: false,
    refactorPass: false,
    screenMocks: false,
    flowcharts: false,
  }),
});

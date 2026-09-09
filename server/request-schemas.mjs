import { MAX_BURST_GOAL } from "./burst-contract.mjs";

// Boundary schemas reject malformed controls before any process, worktree or
// queue mutation. Domain validators still enforce ownership and allowed values.
const text = { type: "string", maxLength: 32_000 };
const id = { type: "string", minLength: 1, maxLength: 128 };
const image = { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 4096 }, name: { type: "string", maxLength: 255 } } };
const body = (properties, required = []) => ({ body: { type: "object", additionalProperties: false, properties, required } });
export const WRITE_SCHEMAS = {
  input: body({ text, enter: { type: "boolean" } }, ["text"]),
  key: body({ key: { type: "string", minLength: 1, maxLength: 32 } }, ["key"]),
  queue: body({ workspaceId: id, surfaceId: id, text }, ["workspaceId", "surfaceId", "text"]),
  queueUpdate: body({ text }, ["text"]),
  queueMove: body({ direction: { type: "integer", enum: [-1, 1] } }, ["direction"]),
  respawn: body({ surfaceId: id }, ["surfaceId"]),
  createGoal: body({
    repositoryId: id,
    goalType: { enum: ["coding", "analysis"] },
    goal: { type: "string", maxLength: 8000 },
    images: { type: "array", maxItems: 4, items: image },
    engine: { type: "object", additionalProperties: false, properties: { provider: { enum: ["claude", "codex"] }, model: { type: "string" }, effort: { type: "string" }, reviewer: { type: "boolean" } } },
    specOptions: { type: "object" }, reviewOptions: { type: "object" },
    intake: { type: "object", additionalProperties: false, properties: { exclusions: { type: "string", maxLength: 4000 }, verification: { type: "string", maxLength: 4000 } } }, burst: { type: "boolean" },
    background: { type: "boolean" }, traceId: id, idempotencyKey: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
    issueNumbers: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1 } }, issueUrls: { type: "array", maxItems: 100, items: { type: "string", maxLength: 1000 } },
  }, ["repositoryId", "goal"]),
  analysisVersion: body({ version: { type: "integer", minimum: 1 } }, ["version"]),
  reviewAction: body({ reviewId: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["reviewId"]),
  reviewDecision: body({ verdict: { enum: ["agree", "disagree"] }, comment: { type: "string", maxLength: 1_000 } }, ["verdict"]),
  reviewSendDecisions: body({ generation: { type: "integer", minimum: 1 }, revision: { type: "integer", minimum: 1 } }, ["generation", "revision"]),
  empty: body({}),
  burstApprove: body({ goal: { type: "string", maxLength: MAX_BURST_GOAL } }),
  updateGoal: body({ tasks: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", required: ["id", "title", "branch", "prompt"], properties: { id, title: { type: "string" }, branch: { type: "string" }, prompt: { type: "string" }, agent: { enum: ["claude", "codex"] } } } } }, ["tasks"]),
};

export function schemaErrorFormatter(errors) {
  const failure = errors[0];
  if (failure.instancePath === "/images" && failure.keyword === "type") return new TypeError("Attached images must be a list");
  const field = failure.instancePath?.split("/").filter(Boolean).join(" ") || failure.params?.missingProperty || "request";
  return new TypeError(`Invalid ${field}: ${failure.message || "check the submitted value"}`);
}

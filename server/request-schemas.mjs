// Boundary schemas reject malformed controls before any process, worktree or
// queue mutation. Domain validators still enforce ownership and allowed values.
const text = { type: "string", maxLength: 32_000 };
const id = { type: "string", minLength: 1, maxLength: 128 };
const body = (properties, required = []) => ({ body: { type: "object", additionalProperties: false, properties, required } });
export const WRITE_SCHEMAS = {
  input: body({ text, enter: { type: "boolean" } }, ["text"]),
  key: body({ key: { type: "string", minLength: 1, maxLength: 32 } }, ["key"]),
  queue: body({ workspaceId: id, surfaceId: id, text }, ["workspaceId", "surfaceId", "text"]),
  queueUpdate: body({ text }, ["text"]),
  queueMove: body({ direction: { type: "integer", enum: [-1, 1] } }, ["direction"]),
  respawn: body({ surfaceId: id }, ["surfaceId"]),

};

export function schemaErrorFormatter(errors) {
  const failure = errors[0];
  if (failure.instancePath === "/images" && failure.keyword === "type") return new TypeError("Attached images must be a list");
  const field = failure.instancePath?.split("/").filter(Boolean).join(" ") || failure.params?.missingProperty || "request";
  return new TypeError(`Invalid ${field}: ${failure.message || "check the submitted value"}`);
}

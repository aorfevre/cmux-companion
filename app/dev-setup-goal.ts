import { AGENT_REPLY_FORMAT } from "../server/agent-reply-format.mjs";

// Plain text deliberately: the same editable goal works with every planner engine.
export const DEV_SETUP_GOAL = `Make this repository easy for a human or any coding LLM to develop, verify and deliver a small change, using its actual stack and existing tools.

Inspect product, architecture, root/scoped instructions (AGENTS.md, CLAUDE.md, any AGENT.md), skills, setup, runtime versions, locks, configuration, tests, CI and release boundaries. Identify concrete gaps with file evidence. Do not assume a language, OS, web app or agent.

Consider TypeScript, Cypress and Astro preferences where the scope fits. Preserve justified project-specific choices; explain exceptions. Do not migrate just to match preferences.

Plan one bounded improvement task with one owner responsible for integration and completion. Prefer fixing existing mechanisms. Keep shared guidance in one authoritative place; provider-specific entry files should point to it and retain only necessary provider differences. Keep the main instructions short: product purpose, important code, critical boundaries and verification; link deeper guidance. Give existing skills clear purposes and relevant loading triggers; add a skill only for demonstrated reusable work.

Document prerequisites/versions, reproducible setup from a fresh checkout, safe configuration/services, how to exercise the primary capability, fast/full verification and delivery. Reuse native commands and suitable services. Adapt to hardware, mobile, libraries, infrastructure, data or docs; identify unavailable resources. Do not impose a container, orchestration layer or LLM vendor.

Use one small real change in the touched scope to test the instructions. Trace its applicable interface, backend, persistence, workers and external services. Record commands, outcomes, manual interventions and remaining gaps. Separate passed, failed, not run and not applicable; do not claim untested providers or platforms work. Preserve regression coverage and existing local-only test policies. Investigate repeated failures instead of retrying the same approach. Make shared verification usable locally and in CI where permitted.

Completion: a newcomer can find and follow setup, exercise the primary capability and verify a change from repository guidance; the owner supplies evidence for the exercised path, unresolved blockers and optional follow-ups. If the current setup already meets this contract, report that with evidence instead of manufacturing edits. Respect user work, secrets, permissions and release approvals. Do not merge, deploy or change external account configuration. Keep cleanup bounded and stop when the agreed scope is verified.

Adopt this shared reply convention in the repository instructions for all coding agents, preserving required provider differences:
${AGENT_REPLY_FORMAT}`;

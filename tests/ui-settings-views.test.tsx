import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { ReleaseRetentionPanel } from "../app/release-retention";
import { ModelSettingsPanel, ModelSelect } from "../app/model-settings";
import { WorktreeCleanupPanel } from "../app/worktree-cleanup";
import { DEFAULT_MODEL_ROLES } from "../server/model-options.mjs";

afterEach(() => { vi.unstubAllGlobals(); });

type Call = { url: string; method: string; body: unknown };
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function stubApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: (init?.method || "GET").toUpperCase(), body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const result = handler(call);
    return result instanceof Response ? result : jsonResponse(result);
  }));
  return calls;
}
function openDetails(details: HTMLDetailsElement) { details.open = true; fireEvent(details, new Event("toggle")); }

describe("release retention panel", () => {
  const releaseState = (enabled: boolean, intervalHours = 24) => ({ policy: { enabled, intervalHours }, history: [{ at: "2026-09-01T00:00:00.000Z", results: [{ path: "/releases/a", outcome: "removed" }, { path: "/releases/b", outcome: "skipped", reason: "locked" }] }] });

  test("loads the policy on first open, saves schedule changes and previews then runs a cleanup", async () => {
    let enabled = false; let interval = 24;
    const calls = stubApi(({ url, method, body }) => {
      if (url.endsWith("/releases") && method === "PATCH") { const patch = body as { enabled?: boolean; intervalHours?: number }; if (patch.enabled !== undefined) enabled = patch.enabled; if (patch.intervalHours !== undefined) interval = patch.intervalHours; return {}; }
      if (url.endsWith("/releases")) return releaseState(enabled, interval);
      if (url.endsWith("/releases/preview")) return { previewId: "preview-1", entries: [
        { path: "/releases/old", target: "current", sha: "abcdef1234567890", eligible: true, reasons: ["superseded"], estimatedBytes: 2 * 1024 ** 3 },
        { path: "/releases/keep", target: "rollback", sha: "fedcba0987654321", eligible: false, reasons: ["rollback target"], estimatedBytes: null },
      ], errors: [{ target: "candidate", error: "unreadable" }] };
      if (url.endsWith("/releases/run")) return { ok: true };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const { container } = render(<ReleaseRetentionPanel />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    assert.equal(screen.queryByText("Release schedule"), null);
    openDetails(details);
    assert.ok(await screen.findByText("Release schedule"));
    assert.ok(screen.getByText("Release cleanup history (1)"));
    assert.ok(screen.getByText("skipped: /releases/b locked"));
    const loads = calls.filter((call) => call.method === "GET").length;
    openDetails(details);
    assert.equal(calls.filter((call) => call.method === "GET").length, loads, "a second open does not reload");

    await userEvent.click(screen.getByRole("checkbox", { name: "Enable automatic release deletion" }));
    await waitFor(() => assert.equal((screen.getByRole("checkbox", { name: "Enable automatic release deletion" }) as HTMLInputElement).checked, true));
    assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, { enabled: true });

    const intervalInput = screen.getByRole("spinbutton", { name: "Release cleanup interval (hours)" });
    fireEvent.blur(intervalInput, { target: { value: "24" } });
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "an unchanged interval is not saved");
    fireEvent.blur(intervalInput, { target: { value: "48" } });
    await waitFor(() => assert.equal(calls.filter((call) => call.method === "PATCH").length, 2));
    assert.deepEqual(calls.at(-2)?.body, { intervalHours: 48 });

    await userEvent.click(screen.getByRole("button", { name: "Preview release retention" }));
    const eligible = await screen.findByRole("checkbox", { name: "Select release abcdef1234567890" });
    assert.ok(screen.getByText(/current abcdef123456: superseded · 2.00 GB/));
    assert.ok(screen.getByText(/rollback fedcba098765: rollback target$/));
    assert.ok(screen.getByText("candidate: unreadable"));
    assert.equal((screen.getByRole("checkbox", { name: "Select release fedcba0987654321" }) as HTMLInputElement).disabled, true);
    const run = screen.getByRole("button", { name: "Run release cleanup" });
    assert.equal((run as HTMLButtonElement).disabled, true);
    await userEvent.click(eligible);
    assert.equal((run as HTMLButtonElement).disabled, false);
    await userEvent.click(eligible);
    assert.equal((run as HTMLButtonElement).disabled, true);
    await userEvent.click(eligible);
    await userEvent.click(run);
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Run release cleanup" }), null));
    assert.deepEqual(calls.find((call) => call.url.endsWith("/releases/run"))?.body, { previewId: "preview-1", ids: ["/releases/old"] });
  });

  test("surfaces API failures without losing the panel", async () => {
    stubApi(({ url }) => url.endsWith("/releases/preview") ? jsonResponse({ error: "Updater is busy" }, 409) : releaseState(true));
    const { container } = render(<ReleaseRetentionPanel />);
    openDetails(container.querySelector("details") as HTMLDetailsElement);
    await screen.findByText("Release schedule");
    await userEvent.click(screen.getByRole("button", { name: "Preview release retention" }));
    assert.equal((await screen.findByRole("alert")).textContent, "Updater is busy");
    assert.ok(screen.getByText("Release schedule"));
  });

  test("shows a generic message when the failure is not an Error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    const { container } = render(<ReleaseRetentionPanel />);
    openDetails(container.querySelector("details") as HTMLDetailsElement);
    assert.equal((await screen.findByRole("alert")).textContent, "Release retention unavailable");
  });
});

describe("model settings panel", () => {
  const roles = () => structuredClone(DEFAULT_MODEL_ROLES);

  test("edits, resets, discards and saves role defaults", async () => {
    let saved = roles();
    const calls = stubApi(({ method, body }) => {
      if (method === "PATCH") { saved = (body as { roles: typeof saved }).roles; return { roles: saved, defaults: roles(), warning: null }; }
      return { roles: saved, defaults: roles(), warning: null };
    });
    render(<ModelSettingsPanel />);
    assert.ok(screen.getByRole("status"));
    const save = await screen.findByRole("button", { name: "Save model defaults" });
    assert.equal(screen.queryByRole("status"), null);
    assert.equal((save as HTMLButtonElement).disabled, true);
    assert.equal(screen.queryByRole("combobox", { name: "Issue analyzer default provider" }), null);

    const plannerProvider = screen.getByRole("combobox", { name: "Planner default provider" }) as HTMLSelectElement;
    assert.equal(plannerProvider.value, "codex");
    await userEvent.selectOptions(plannerProvider, "claude");
    assert.equal((save as HTMLButtonElement).disabled, false);
    const discard = screen.getByRole("button", { name: "Discard changes" });
    await userEvent.click(discard);
    assert.equal(plannerProvider.value, "codex");
    assert.equal((save as HTMLButtonElement).disabled, true);

    const coderClaude = screen.getByRole("combobox", { name: "Coder Claude model" }) as HTMLSelectElement;
    await userEvent.selectOptions(coderClaude, "claude-opus-5");
    assert.equal(coderClaude.value, "claude-opus-5");
    await userEvent.click(screen.getByRole("button", { name: "Reset coder" }));
    assert.equal(coderClaude.value, "default");
    assert.equal((save as HTMLButtonElement).disabled, true);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Merge agent Codex model" }), "__custom__");
    const custom = screen.getByRole("textbox", { name: "Merge agent Codex model ID" });
    await userEvent.type(custom, "gpt-7-nova");
    await userEvent.click(save);
    assert.ok(await screen.findByText("Model defaults saved"));
    const patch = calls.find((call) => call.method === "PATCH")?.body as { roles: Record<string, { models: Record<string, string> }> };
    assert.equal(patch.roles.merger.models.codex, "gpt-7-nova");
    assert.equal((screen.getByRole("textbox", { name: "Merge agent Codex model ID" }) as HTMLInputElement).value, "gpt-7-nova");
    assert.equal((save as HTMLButtonElement).disabled, true);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Merge agent Codex model" }), "gpt-5.6-sol");
    assert.equal(screen.queryByRole("textbox", { name: "Merge agent Codex model ID" }), null);
    assert.equal(screen.queryByText("Model defaults saved"), null);
  });

  test("warns about the stored configuration and allows saving it unchanged", async () => {
    stubApi(({ method }) => method === "PATCH" ? jsonResponse({ error: "Model must be an ID" }, 400) : { roles: roles(), defaults: roles(), warning: "A retired model id was rewritten" });
    render(<ModelSettingsPanel />);
    assert.ok(await screen.findByText("A retired model id was rewritten"));
    const save = screen.getByRole("button", { name: "Save model defaults" }) as HTMLButtonElement;
    assert.equal(save.disabled, false);
    await userEvent.click(save);
    assert.equal((await screen.findByRole("alert")).textContent, "Model must be an ID");
    assert.equal(save.disabled, false);
  });

  test("offers a retry when the settings cannot be loaded", async () => {
    let attempts = 0;
    stubApi(() => { attempts += 1; return attempts === 1 ? jsonResponse({ error: "Settings store locked" }, 503) : { roles: roles(), defaults: roles(), warning: null }; });
    render(<ModelSettingsPanel />);
    assert.equal((await screen.findByRole("alert")).textContent, "Settings store locked");
    await userEvent.click(screen.getByRole("button", { name: "Retry loading model defaults" }));
    assert.ok(await screen.findByRole("button", { name: "Save model defaults" }));
    assert.equal(screen.queryByRole("alert"), null);
  });

  test("reports load failures that are not errors and keeps retrying", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { attempts += 1; throw "offline"; }));
    render(<ModelSettingsPanel />);
    assert.equal((await screen.findByRole("alert")).textContent, "Could not load model settings");
    await userEvent.click(screen.getByRole("button", { name: "Retry loading model defaults" }));
    await waitFor(() => assert.equal(attempts, 2));
    assert.equal(screen.getByRole("alert").textContent, "Could not load model settings");
  });

  test("model select switches between suggestions and a custom id", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ModelSelect label="Test model" provider="claude" value="claude-opus-5" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Test model" }) as HTMLSelectElement;
    assert.equal(select.value, "claude-opus-5");
    assert.ok(within(select).getByRole("option", { name: "Provider default" }));
    assert.equal(screen.queryByRole("textbox"), null);
    await userEvent.selectOptions(select, "__custom__");
    assert.deepEqual(onChange.mock.calls.at(-1), [""]);
    rerender(<ModelSelect label="Test model" caption="Custom" provider="claude" value="" onChange={onChange} />);
    assert.equal(select.value, "__custom__");
    assert.ok(screen.getByText("Custom"));
    await userEvent.type(screen.getByRole("textbox", { name: "Test model ID" }), "x");
    assert.deepEqual(onChange.mock.calls.at(-1), ["x"]);
    await userEvent.selectOptions(select, "default");
    assert.deepEqual(onChange.mock.calls.at(-1), ["default"]);
  });
});

describe("worktree cleanup panel", () => {
  const policy = { enabled: false, intervalHours: 24, graceDays: 7, pruneEnabled: false, pruneGraceDays: 30 };
  const preview = () => ({ previewId: "preview-7", summary: { candidates: 1, protected: 1, estimatedBytes: 3 * 1024 ** 3 }, entries: [
    { id: "wt-1", path: "/work/feature", branch: "feature/x", classification: "merged", eligible: true, reasons: ["merged PR"], estimatedBytes: 1024 ** 3 },
    { id: "wt-2", path: "/work/dirty", branch: null, classification: "development root", eligible: false, reasons: ["uncommitted changes"], estimatedBytes: null },
  ], errors: [{ path: "/work/broken", error: "not a git repository" }], prune: [{ common: "/repo/.git", repositoryPath: "/repo", paths: ["/gone"], eligible: true, reason: "missing for 40 days" }] });

  test("opens, configures the policy, previews and runs a cleanup with prune", async () => {
    let current = { ...policy };
    const calls = stubApi(({ url, method, body }) => {
      if (url.endsWith("/api/worktree-cleanup") && method === "PATCH") { current = { ...current, ...(body as object) }; return { policy: current }; }
      if (url.endsWith("/api/worktree-cleanup")) return { policy: current, history: [{ at: "2026-09-01T00:00:00.000Z", estimatedReclaimedBytes: 1024 ** 3, results: [{ path: "/old", outcome: "removed" }, { path: "/kept", outcome: "skipped", reason: "dirty" }] }] };
      if (url.endsWith("/preview")) return preview();
      if (url.endsWith("/run")) return { at: "2026-09-02T00:00:00.000Z", results: [{ path: "/work/feature", outcome: "removed" }, { path: "/work/other", outcome: "failed", reason: "busy" }, { path: "/work/skip", outcome: "skipped" }] };
      if (url.endsWith("/releases")) return { policy: { enabled: false, intervalHours: 24 }, history: [] };
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<WorktreeCleanupPanel />);
    const toggle = screen.getByRole("button", { name: "Worktree cleanup" });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await userEvent.click(toggle);
    assert.ok(await screen.findByText("Automatic deletion disabled. Verified merged goal PRs qualify immediately. Other merged worktrees use the grace period from their first eligible observation. Managed releases have a separate updater retention policy."));
    assert.ok(screen.getByText("Cleanup history (1)"));
    assert.ok(screen.getByText(/estimated 1.00 GB reclaimed/));
    assert.ok(screen.getByText("skipped: /kept — dirty"));
    assert.ok(screen.getByText("removed: /old"));

    await userEvent.click(screen.getByRole("checkbox", { name: "Enable automatic development worktree deletion" }));
    assert.ok(await screen.findByText(/Automatic deletion enabled/));
    await userEvent.click(screen.getByRole("checkbox", { name: "Allow Git to prune expired missing registrations" }));
    await waitFor(() => assert.equal((screen.getByRole("checkbox", { name: "Allow Git to prune expired missing registrations" }) as HTMLInputElement).checked, true));
    for (const [label, unchanged, changed, key] of [["Grace period (days)", "7", "3", "graceDays"], ["Schedule (hours)", "24", "12", "intervalHours"], ["Prune grace (days)", "30", "45", "pruneGraceDays"]] as const) {
      const patches = calls.filter((call) => call.method === "PATCH").length;
      fireEvent.blur(screen.getByRole("spinbutton", { name: label }), { target: { value: unchanged } });
      assert.equal(calls.filter((call) => call.method === "PATCH").length, patches);
      fireEvent.blur(screen.getByRole("spinbutton", { name: label }), { target: { value: changed } });
      await waitFor(() => assert.equal(calls.filter((call) => call.method === "PATCH").length, patches + 1));
      assert.deepEqual(calls.filter((call) => call.method === "PATCH").at(-1)?.body, { [key]: Number(changed) });
    }
    assert.equal(calls.filter((call) => call.url.endsWith("/api/worktree-cleanup") && call.method === "GET").length, 1, "policy patches update state without reloading");

    await userEvent.click(screen.getByRole("button", { name: "Preview cleanup" }));
    assert.ok(await screen.findByText("1 eligible · 1 protected · approximately 3.00 GB reclaimable"));
    assert.ok(screen.getByText("Eligible: merged PR"));
    assert.ok(screen.getByText("Protected: uncommitted changes"));
    assert.ok(screen.getByText("Unknown"));
    assert.ok(screen.getByText("development root"));
    assert.ok(screen.getByRole("status"));
    assert.ok(screen.getByText("/work/broken: not a git repository"));
    const run = screen.getByRole("button", { name: "Run cleanup" }) as HTMLButtonElement;
    assert.equal(run.disabled, true);
    assert.equal((screen.getByRole("checkbox", { name: "Select /work/dirty" }) as HTMLInputElement).disabled, true);
    const prune = screen.getByLabelText(/\/repo: missing for 40 days. \/gone/) as HTMLInputElement;
    await userEvent.click(prune);
    assert.equal(run.disabled, false);
    await userEvent.click(prune);
    assert.equal(run.disabled, true);
    await userEvent.click(prune);
    const select = screen.getByRole("checkbox", { name: "Select /work/feature" });
    await userEvent.click(select);
    await userEvent.click(select);
    await userEvent.click(select);
    await userEvent.click(run);
    assert.ok(await screen.findByText("1 worktrees removed; 2 skipped or failed."));
    assert.deepEqual(calls.find((call) => call.url.endsWith("/run"))?.body, { previewId: "preview-7", ids: ["wt-1"], prune: ["/repo/.git"] });
    assert.equal(screen.queryByRole("button", { name: "Run cleanup" }), null);

    await userEvent.click(toggle);
    assert.equal(screen.queryByText("Cleanup history (1)"), null);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  test("reports failures from the preview and a status load that is not an Error", async () => {
    stubApi(({ url }) => url.endsWith("/preview") ? jsonResponse({ error: "Scan in progress" }, 409) : { policy, history: [] });
    render(<WorktreeCleanupPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Worktree cleanup" }));
    await screen.findByText("Cleanup history (0)");
    await userEvent.click(screen.getByRole("button", { name: "Preview cleanup" }));
    assert.equal((await screen.findByRole("alert")).textContent, "Scan in progress");
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    await userEvent.click(screen.getByRole("button", { name: "Worktree cleanup" }));
    await userEvent.click(screen.getByRole("button", { name: "Worktree cleanup" }));
    assert.equal((await screen.findByRole("alert")).textContent, "Cleanup failed");
  });
});

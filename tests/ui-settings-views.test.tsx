import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { ReleaseRetentionPanel } from "../app/release-retention";
import { ModelSettingsPanel, ModelSelect } from "../app/model-settings";
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

    assert.equal(screen.queryByRole("combobox", { name: "Planner default provider" }), null);
    const coderModel = screen.getByRole("combobox", { name: "Coder Codex model" }) as HTMLSelectElement;
    assert.equal(coderModel.value, "default");
    await userEvent.selectOptions(coderModel, "gpt-5.6-sol");
    assert.equal((save as HTMLButtonElement).disabled, false);
    const discard = screen.getByRole("button", { name: "Discard changes" });
    await userEvent.click(discard);
    assert.equal(coderModel.value, "default");
    assert.equal((save as HTMLButtonElement).disabled, true);

    const coderClaude = screen.getByRole("combobox", { name: "Coder Claude model" }) as HTMLSelectElement;
    await userEvent.selectOptions(coderClaude, "claude-opus-5");
    assert.equal(coderClaude.value, "claude-opus-5");
    await userEvent.click(screen.getByRole("button", { name: "Reset coder" }));
    assert.equal(coderClaude.value, "default");
    assert.equal((save as HTMLButtonElement).disabled, true);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Coder Codex model" }), "__custom__");
    const custom = screen.getByRole("textbox", { name: "Coder Codex model ID" });
    await userEvent.type(custom, "gpt-7-nova");
    await userEvent.click(save);
    assert.ok(await screen.findByText("Model defaults saved"));
    const patch = calls.find((call) => call.method === "PATCH")?.body as { roles: Record<string, { models: Record<string, string> }> };
    assert.equal(patch.roles.coder.models.codex, "gpt-7-nova");
    assert.equal((screen.getByRole("textbox", { name: "Coder Codex model ID" }) as HTMLInputElement).value, "gpt-7-nova");
    assert.equal((save as HTMLButtonElement).disabled, true);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Coder Codex model" }), "gpt-5.6-sol");
    assert.equal(screen.queryByRole("textbox", { name: "Coder Codex model ID" }), null);
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

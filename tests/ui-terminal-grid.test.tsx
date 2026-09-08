import assert from "node:assert/strict";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, test, vi } from "vitest";
import { TerminalGrid, type TerminalView } from "../app/terminal-grid.tsx";
import { ProposalReview } from "../app/proposal-review";
import { PromptDisclosure } from "../app/prompt-markdown";

type Grid = Extract<TerminalView, { mode: "grid" }>["render_grid"];
const baseGrid = (extra: Partial<Grid> = {}): Grid => ({
  format: "cmux.render-grid.v1", columns: 40, rows: 4, scrollback_rows: 1,
  styles: [
    { id: 0 },
    { id: 1, foreground: "#ff0000", background: "#00ff00", bold: true, italic: true, faint: true, underline: true, strikethrough: true, overline: true, blink: true },
    { id: 2, inverse: true, invisible: true },
    { id: 3, foreground: "url(evil)" },
  ],
  scrollback_spans: [{ row: 0, column: 0, cell_width: 7, style_id: 0, text: "history" }],
  row_spans: [
    { row: 0, column: 0, cell_width: 5, style_id: 1, text: "fancy" },
    { row: 0, column: 6, cell_width: 6, style_id: 2, text: "hidden" },
    { row: 1, column: 2, cell_width: 12, style_id: 3, text: "docs/plan.md" },
    { row: 2, column: 0, cell_width: 21, style_id: 0, text: "http://localhost:3000" },
  ],
  cursor: { row: 1, column: 3, visible: true, blinking: true, style: "bar" },
  terminal_foreground: "#f0f0f0", terminal_background: "#101010", terminal_cursor_color: "#00aaff",
  ...extra,
});

describe("TerminalGrid", () => {
  test("shows a loading placeholder without a view and a fallback for text views", () => {
    const { rerender } = render(<TerminalGrid view={null} />);
    assert.ok(screen.getByText("Reading terminal…"));
    rerender(<TerminalGrid view={{ mode: "text", text: "" }} />);
    assert.ok(screen.getByText("No terminal output yet."));
    rerender(<TerminalGrid view={{ mode: "text", text: "result\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/repo" }} hideNativeComposer />);
    assert.equal(document.querySelector(".terminal-fallback")?.textContent, "result");
    rerender(<TerminalGrid view={{ mode: "grid", render_grid: { format: "other" } as unknown as Grid }} />);
    assert.ok(screen.getByText("Terminal replay is unavailable."));
  });

  test("renders plain text references as inert text unless handlers are supplied", async () => {
    const markdown = vi.fn(); const local = vi.fn();
    const { rerender } = render(<TerminalGrid view={{ mode: "text", text: "Read docs/plan.md then http://localhost:3000" }} />);
    assert.equal(screen.queryByRole("button"), null);
    rerender(<TerminalGrid view={{ mode: "text", text: "Read docs/plan.md then http://localhost:3000" }} onMarkdownLink={markdown} onLocalUrl={local} />);
    await userEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "http://localhost:3000" }));
    assert.deepEqual(markdown.mock.calls, [["docs/plan.md"]]);
    assert.deepEqual(local.mock.calls, [["http://localhost:3000"]]);
  });

  test("lays out grid spans by column with safe styles and a cursor", async () => {
    const markdown = vi.fn();
    render(<TerminalGrid view={{ mode: "grid", render_grid: baseGrid() }} onMarkdownLink={markdown} />);
    const log = screen.getByRole("log", { name: "Terminal output" });
    assert.equal(log.style.width, "40ch");
    assert.equal(log.style.getPropertyValue("--terminal-foreground"), "#f0f0f0");
    assert.equal(log.style.getPropertyValue("--terminal-background"), "#101010");
    const rows = log.querySelectorAll(".terminal-grid-row");
    assert.equal(rows.length, 5);
    assert.equal(rows[0].textContent, "history");
    const fancy = within(rows[1] as HTMLElement).getByText("fancy") as HTMLElement;
    assert.equal(fancy.style.gridColumn, "1 / span 5");
    assert.equal(fancy.style.color, "rgb(255, 0, 0)");
    assert.equal(fancy.style.backgroundColor, "rgb(0, 255, 0)");
    assert.equal(fancy.style.fontWeight, "700");
    assert.equal(fancy.style.fontStyle, "italic");
    assert.equal(fancy.style.opacity, "0.58");
    assert.equal(fancy.style.textDecoration, "underline line-through overline");
    assert.ok(fancy.classList.contains("blinking"));
    const hidden = within(rows[1] as HTMLElement).getByText("hidden") as HTMLElement;
    assert.equal(hidden.style.color, "transparent");
    assert.equal(hidden.style.backgroundColor, "rgb(240, 240, 240)", "inverse swaps the terminal foreground into the fill");
    assert.ok(!hidden.classList.contains("blinking"));
    const link = within(rows[2] as HTMLElement).getByRole("button", { name: "docs/plan.md" });
    assert.equal((link.parentElement as HTMLElement).style.color, "rgb(240, 240, 240)", "unsafe colours fall back to the terminal foreground");
    await userEvent.click(link);
    assert.deepEqual(markdown.mock.calls, [["docs/plan.md"]]);
    assert.equal(screen.queryByRole("button", { name: "http://localhost:3000" }), null);
    const cursor = rows[2].querySelector(".terminal-cursor") as HTMLElement;
    assert.ok(cursor.classList.contains("bar"));
    assert.ok(cursor.classList.contains("blinking"));
    assert.equal(cursor.style.gridColumn, "4 / span 1");
    assert.equal(cursor.style.borderColor, "rgb(0, 170, 255)");
    assert.equal(log.querySelectorAll(".terminal-cursor").length, 1);
  });

  test("hides the cursor when it is invisible or when the native composer crops its row", () => {
    const { rerender } = render(<TerminalGrid view={{ mode: "grid", render_grid: baseGrid({ cursor: { row: 1, column: 3, visible: false, blinking: false, style: "block" } }) }} />);
    assert.equal(document.querySelectorAll(".terminal-cursor").length, 0);
    const composer = baseGrid({ rows: 8, cursor: { row: 6, column: 0, visible: true, blinking: false, style: "block" }, row_spans: [
      { row: 0, column: 0, cell_width: 6, style_id: 0, text: "output" },
      { row: 5, column: 0, cell_width: 26, style_id: 0, text: "› Ask Codex to do anything" },
      { row: 7, column: 0, cell_width: 12, style_id: 0, text: "gpt-5.6-sol" },
    ] });
    rerender(<TerminalGrid view={{ mode: "grid", render_grid: composer }} hideNativeComposer />);
    const rows = document.querySelectorAll(".terminal-grid-row");
    assert.equal(rows.length, 1 + 4, "scrollback plus the rows above the composer");
    assert.equal(document.querySelectorAll(".terminal-cursor").length, 0);
    assert.equal(screen.queryByText("› Ask Codex to do anything"), null);
    rerender(<TerminalGrid view={{ mode: "grid", render_grid: composer }} />);
    assert.equal(document.querySelectorAll(".terminal-grid-row").length, 9);
    assert.ok(screen.getByText("› Ask Codex to do anything"));
  });

  test("reflow mode collapses column gaps and marks decorative rules", async () => {
    const local = vi.fn();
    const grid = baseGrid({ columns: 60, rows: 4, scrollback_rows: 0, scrollback_spans: [], row_spans: [
      { row: 0, column: 30, cell_width: 3, style_id: 1, text: "end" },
      { row: 0, column: 0, cell_width: 5, style_id: 0, text: "start" },
      { row: 0, column: 5, cell_width: 20, style_id: 0, text: "            " },
      { row: 1, column: 0, cell_width: 40, style_id: 0, text: "────────────────────" },
      { row: 2, column: 0, cell_width: 5, style_id: 0, text: "     " },
      { row: 3, column: 2, cell_width: 21, style_id: 0, text: "http://localhost:3000   " },
    ] });
    render(<TerminalGrid view={{ mode: "grid", render_grid: grid }} reflow onLocalUrl={local} />);
    const log = screen.getByRole("log");
    assert.ok(log.classList.contains("reflow"));
    assert.equal(log.style.width, "100%");
    const rows = log.querySelectorAll(".terminal-grid-row");
    assert.equal(rows[0].textContent, `start${" ".repeat(8)}${" ".repeat(5)}end`, "long space runs shrink to eight, gaps cap at eight, and ordering follows columns");
    assert.ok(rows[1].classList.contains("decorative"));
    assert.equal(rows[2].textContent, "", "blank rows render nothing");
    assert.ok(!rows[2].classList.contains("decorative"));
    assert.equal(rows[3].textContent, "  http://localhost:3000", "the trailing span is trimmed");
    assert.equal(within(rows[0] as HTMLElement).getByText("end").classList.contains("blinking"), true);
    await userEvent.click(screen.getByRole("button", { name: "http://localhost:3000" }));
    assert.deepEqual(local.mock.calls, [["http://localhost:3000"]]);
    assert.equal(log.querySelectorAll(".terminal-cursor").length, 0, "reflow never draws the cursor");
  });
});

describe("ProposalReview", () => {
  test("shows the goal when no intended behaviour is saved and hides empty sections", () => {
    render(<ProposalReview proposal={{}} goal="Ship the thing" />);
    const region = screen.getByRole("region", { name: "Proposal details" });
    assert.equal(region.tabIndex, 0);
    assert.ok(within(region).getByText("Ship the thing"));
    assert.equal(within(region).queryByText("In scope"), null);
    assert.equal(within(region).queryByText(/Acceptance criteria/), null);
  });

  test("renders every saved section with counts and optional verification", () => {
    render(<ProposalReview proposal={{ intendedBehavior: "Users can log in", scope: ["auth"], exclusions: ["billing", "reports"], assumptions: ["SSO exists"], acceptanceCriteria: [{ text: "Login works", verification: "Run e2e" }, { text: "Logout works", verification: "" }], verification: ["npm test"] }} goal="ignored" />);
    assert.ok(screen.getByText("Users can log in"));
    assert.equal(screen.queryByText("ignored"), null);
    assert.equal(screen.getByRole("heading", { name: "In scope 1" }).tagName, "H3");
    assert.ok(screen.getByRole("heading", { name: "Out of scope 2" }));
    assert.ok(screen.getByRole("heading", { name: "Assumptions 1" }));
    assert.ok(screen.getByRole("heading", { name: "Acceptance criteria 2" }));
    assert.ok(screen.getByRole("heading", { name: "Verification plan 1" }));
    assert.equal(screen.getAllByText("How to verify").length, 1);
    assert.ok(screen.getByText("Run e2e"));
    assert.ok(screen.getByText("Logout works"));
  });
});

describe("PromptDisclosure", () => {
  test("renders Markdown with safe links and toggles to the raw prompt", async () => {
    const text = "## Task\n\n- Edit `app/page.tsx`\n- See [docs](https://example.com/docs) and [local](docs/plan.md)\n\n<script>alert(1)</script>";
    render(<PromptDisclosure label="task prompt" summary={<b>Task 1</b>} text={text}><em>extra</em></PromptDisclosure>);
    assert.ok(screen.getByText("Task 1"));
    assert.ok(screen.getByText("extra"));
    assert.ok(screen.getByRole("heading", { name: "Task" }));
    assert.equal(screen.getByText("app/page.tsx").tagName, "CODE");
    const external = screen.getByRole("link", { name: "docs" });
    assert.equal(external.getAttribute("href"), "https://example.com/docs");
    assert.equal(external.getAttribute("target"), "_blank");
    assert.equal(screen.queryByRole("link", { name: "local" }), null);
    assert.equal(screen.getByText("local").tagName, "SPAN");
    assert.equal(document.querySelector("script"), null);
    assert.ok(screen.getByText(/alert\(1\)/));
    const toggle = screen.getByRole("button", { name: "Show task prompt as raw text" });
    assert.equal(toggle.textContent, "Raw");
    await userEvent.click(toggle);
    assert.equal(screen.getByRole("button", { name: "Show task prompt as Markdown" }).textContent, "Rendered");
    assert.equal(document.querySelector(".planner-prompt-raw")?.textContent, text);
    assert.equal(screen.queryByRole("heading", { name: "Task" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Show task prompt as Markdown" }));
    assert.ok(screen.getByRole("heading", { name: "Task" }));
  });
});

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

// jsdom has no layout/scrolling implementation; focused preview timers still call this API.
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), writable: true, configurable: true });
Object.defineProperty(window, "scrollTo", { value: vi.fn(), writable: true });
Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });

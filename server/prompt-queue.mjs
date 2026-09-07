import { readPrivateJson } from "./private-json-state.mjs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "prompt-queue.json");
const CONTEXT_ID = /^[a-zA-Z0-9:_-]{3,128}$/;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_ITEMS = 100;

export class PromptQueue extends EventEmitter {
  constructor({ path = process.env.CMUX_COMPANION_QUEUE_FILE || DEFAULT_PATH, now = () => new Date() } = {}) {
    super();
    this.path = path;
    this.now = now;
    this.state = this.load();
    this.inFlight = new Set();
    this.drainTimers = new Map();
  }

  list({ workspaceId = null, surfaceId = null } = {}) {
    if (workspaceId !== null) assertContextId(workspaceId, "workspace");
    if (surfaceId !== null) assertContextId(surfaceId, "terminal");
    const items = this.state.items
      .filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .filter((item) => !surfaceId || item.surfaceId === surfaceId)
      .map((item) => ({ ...item }));
    return { items, count: items.length };
  }

  enqueue({ workspaceId, surfaceId, text } = {}) {
    assertContextId(workspaceId, "workspace");
    assertContextId(surfaceId, "terminal");
    const prompt = normalizePrompt(text);
    if (this.state.items.length >= MAX_ITEMS) throw new TypeError("The prompt queue is full");
    const timestamp = this.now().toISOString();
    const item = {
      id: randomUUID(), workspaceId, surfaceId, text: prompt,
      createdAt: timestamp, updatedAt: timestamp, attempts: 0, lastError: null,
    };
    this.state.items.push(item);
    this.save();
    this.emitChanged(item.workspaceId);
    return { item: { ...item }, count: this.list({ workspaceId, surfaceId }).count };
  }

  update(id, { text } = {}) {
    const item = this.require(id);
    item.text = normalizePrompt(text);
    item.updatedAt = this.now().toISOString();
    item.lastError = null;
    this.save();
    this.emitChanged(item.workspaceId);
    return { item: { ...item } };
  }

  move(id, direction) {
    const item = this.require(id);
    const step = Number(direction);
    if (step !== -1 && step !== 1) throw new TypeError("Queue direction must be -1 or 1");
    const siblings = this.state.items.filter((candidate) => candidate.workspaceId === item.workspaceId && candidate.surfaceId === item.surfaceId);
    const position = siblings.findIndex((candidate) => candidate.id === item.id);
    const neighbor = siblings[position + step];
    if (!neighbor) return { item: { ...item } };
    const left = this.state.items.findIndex((candidate) => candidate.id === item.id);
    const right = this.state.items.findIndex((candidate) => candidate.id === neighbor.id);
    [this.state.items[left], this.state.items[right]] = [this.state.items[right], this.state.items[left]];
    item.updatedAt = this.now().toISOString();
    this.save();
    this.emitChanged(item.workspaceId);
    return { item: { ...item } };
  }

  remove(id) {
    const item = this.require(id);
    if (this.inFlight.has(item.id)) throw new TypeError("That prompt is being sent");
    this.state.items = this.state.items.filter((candidate) => candidate.id !== id);
    this.save();
    this.emitChanged(item.workspaceId);
    return { removed: true };
  }

  async sendNow(id, cmux) {
    return this.dispatch(this.require(id), cmux);
  }

  async drain(workspaceId, cmux) {
    assertContextId(workspaceId, "workspace");
    const item = this.state.items.find((candidate) => candidate.workspaceId === workspaceId && !this.inFlight.has(candidate.id));
    if (!item) return { sent: false, reason: "empty" };
    return this.dispatch(item, cmux);
  }

  async dispatch(item, cmux) {
    if (!cmux?.sendPrompt) throw new TypeError("cmux input is unavailable");
    if (this.inFlight.has(item.id)) return { sent: false, reason: "already-sending" };
    this.inFlight.add(item.id);
    try {
      await cmux.sendPrompt(item.surfaceId, item.text);
      this.state.items = this.state.items.filter((candidate) => candidate.id !== item.id);
      this.save();
      this.emitChanged(item.workspaceId);
      return { sent: true, item: { ...item } };
    } catch (error) {
      item.attempts += 1;
      item.updatedAt = this.now().toISOString();
      item.lastError = "Could not reach that cmux terminal";
      this.save();
      this.emitChanged(item.workspaceId);
      throw error;
    } finally {
      this.inFlight.delete(item.id);
    }
  }

  attach({ hub, cmux }) {
    const onEvent = (event) => {
      if (event?.name !== "agent.hook.Stop") return;
      const workspaceId = event.workspace_id || event.payload?.workspace_id || event.data?.workspace_id;
      if (!workspaceId || !CONTEXT_ID.test(workspaceId)) return;
      clearTimeout(this.drainTimers.get(workspaceId));
      const timer = setTimeout(() => {
        this.drainTimers.delete(workspaceId);
        this.drain(workspaceId, cmux).catch(() => {});
      }, 500);
      timer.unref?.();
      this.drainTimers.set(workspaceId, timer);
    };
    hub.on("event", onEvent);
    hub.addConsumer();
    return () => {
      hub.off("event", onEvent);
      hub.removeConsumer();
      for (const timer of this.drainTimers.values()) clearTimeout(timer);
      this.drainTimers.clear();
    };
  }

  require(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("Invalid queued prompt");
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) throw new TypeError("Unknown queued prompt");
    return item;
  }

  emitChanged(workspaceId) {
    this.emit("changed", { workspaceId, count: this.list({ workspaceId }).count });
  }

  load() {
    const value = readPrivateJson(this.path, { items: [] }, value => value !== null && typeof value === "object" && Array.isArray(value.items));
    const items = Array.isArray(value.items) ? value.items.map(normalizeStoredItem).filter(Boolean).slice(-MAX_ITEMS) : [];
    return { items };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function normalizePrompt(value) {
  if (typeof value !== "string") throw new TypeError("A prompt is required");
  const text = value.trim();
  if (!text) throw new TypeError("A prompt is required");
  if (text.length > MAX_PROMPT_LENGTH) throw new TypeError(`Prompt must be ${MAX_PROMPT_LENGTH.toLocaleString()} characters or fewer`);
  return text;
}

function assertContextId(value, label) {
  if (typeof value !== "string" || !CONTEXT_ID.test(value)) throw new TypeError(`Invalid ${label}`);
}

function normalizeStoredItem(item) {
  try {
    assertContextId(item.workspaceId, "workspace");
    assertContextId(item.surfaceId, "terminal");
    const text = normalizePrompt(item.text);
    if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id)) return null;
    return {
      id: item.id, workspaceId: item.workspaceId, surfaceId: item.surfaceId, text,
      createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      attempts: Math.max(0, Number(item.attempts) || 0), lastError: typeof item.lastError === "string" ? item.lastError : null,
    };
  } catch {
    return null;
  }
}

import { EventEmitter } from "node:events";
import { spawn as defaultSpawn } from "node:child_process";
import readline from "node:readline";

export class CmuxEventHub extends EventEmitter {
  constructor({ bin, socketPassword = null, spawn = defaultSpawn, retryDelay = 2_000 } = {}) {
    super();
    this.bin = bin;
    this.spawn = spawn;
    this.retryDelay = retryDelay;
    this.socketPassword = socketPassword;
    this.process = null;
    this.consumers = 0;
    this.retryTimer = null;
  }

  addConsumer() {
    this.consumers += 1;
    if (!this.process) this.start();
  }

  removeConsumer() {
    this.consumers = Math.max(0, this.consumers - 1);
    if (this.consumers === 0) this.stop();
  }

  start() {
    if (this.process || this.consumers === 0) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.spawn(this.bin, [
      "events", "--reconnect", "--no-ack", "--no-heartbeats",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.socketPassword ? { CMUX_SOCKET_PASSWORD: this.socketPassword } : {}),
      },
    });
    this.process = child;
    child.once("spawn", () => {
      if (this.process === child) this.emit("state", { connected: true });
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.process !== child) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        payload = { name: "raw", data: line };
      }
      this.emit("event", payload);
    });

    child.stderr.resume();
    child.once("error", (error) => {
      if (this.process === child) this.emit("state", { connected: false, error: error.message });
    });
    // close follows both failed spawns and normal exits, after stdio closes.
    // Only the current child owns the state/retry; stopped children may close
    // after another consumer has already started a replacement.
    child.once("close", () => {
      lines.close();
      if (this.process !== child) return;
      this.process = null;
      this.emit("state", { connected: false });
      if (this.consumers > 0) {
        this.retryTimer = setTimeout(() => this.start(), this.retryDelay);
        this.retryTimer.unref?.();
      }
    });
  }

  stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.process) {
      const child = this.process;
      this.process = null;
      child.kill();
    }
  }
}

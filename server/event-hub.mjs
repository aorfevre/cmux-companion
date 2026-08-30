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
    this.emit("state", { connected: true });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.emit("event", JSON.parse(line));
      } catch {
        this.emit("event", { name: "raw", data: line });
      }
    });

    child.once("error", (error) => this.emit("state", { connected: false, error: error.message }));
    child.once("exit", () => {
      lines.close();
      if (this.process === child) this.process = null;
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
      this.process.kill();
      this.process = null;
    }
  }
}

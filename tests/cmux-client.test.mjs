import assert from "node:assert/strict";
import test from "node:test";
import { CmuxClient } from "../server/cmux-client.mjs";

const ID = "11111111-2222-4333-8444-555555555555";

test("uses argv-only cmux commands for screen reads", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/fake/cmux",
    execute: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: "last output\n", stderr: "" };
    },
  });

  const result = await client.readScreen(ID, 99);
  assert.deepEqual(result, { text: "last output", lines: 99 });
  assert.equal(calls[0].bin, "/fake/cmux");
  assert.deepEqual(calls[0].args, [
    "read-screen", "--surface", ID, "--scrollback", "--lines", "99",
  ]);
  assert.equal(calls[0].options.shell, undefined);
});

test("sends a prompt and Enter as separate, allow-listed operations", async () => {
  const calls = [];
  const client = new CmuxClient({
    execute: async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  await client.sendPrompt(ID, "please continue");
  assert.deepEqual(calls, [
    ["send", "--surface", ID, "--", "please continue"],
    ["send-key", "--surface", ID, "--", "enter"],
  ]);
});

test("rejects arbitrary targets, keys, and oversized input", async () => {
  const client = new CmuxClient({ execute: async () => ({ stdout: "", stderr: "" }) });
  await assert.rejects(() => client.readScreen("surface:1"), /Invalid cmux target/);
  await assert.rejects(() => client.sendKey(ID, "cmd+q"), /Unsupported key/);
  await assert.rejects(() => client.sendText(ID, "x".repeat(16_001)), /16,000/);
});

test("parses JSON output and rejects malformed JSON", async () => {
  const valid = new CmuxClient({ execute: async () => ({ stdout: '{"methods":["system.ping"]}', stderr: "" }) });
  assert.deepEqual(await valid.capabilities(), { methods: ["system.ping"] });

  const invalid = new CmuxClient({ execute: async () => ({ stdout: "not-json", stderr: "" }) });
  await assert.rejects(() => invalid.capabilities(), /invalid JSON/);
});

test("passes the private socket credential only to cmux child processes", async () => {
  let childEnvironment;
  const client = new CmuxClient({
    socketPassword: "private-socket-credential",
    execute: async (_bin, _args, options) => {
      childEnvironment = options.env;
      return { stdout: "PONG", stderr: "" };
    },
  });
  await client.ping();
  assert.equal(childEnvironment.CMUX_SOCKET_PASSWORD, "private-socket-credential");
});

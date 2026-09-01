import assert from "node:assert/strict";
import test from "node:test";
import { CmuxGroups } from "../server/cmux-groups.mjs";

function fake({ groups = [], fail = null } = {}) {
  const calls = [];
  const cmux = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (fail === method) throw new Error("cmux is unavailable");
      if (method === "workspace.group.list") return { groups };
      if (method === "workspace.group.create") return { group: { id: "group-new" } };
      return {};
    },
  };
  return { cmux, calls, service: new CmuxGroups({ cmux }) };
}

test("creates a group anchored on the first workspace when no group carries the name", async () => {
  const { service, calls } = fake();
  const id = await service.ensure("companion", "workspace-one");
  assert.equal(id, "group-new");
  const create = calls.find((call) => call[0] === "workspace.group.create");
  assert.equal(create[1].workspace_ids[0], "workspace-one");
  assert.equal(calls.find((call) => call[0] === "workspace.group.rename")[1].name, "companion");
});

test("reuses a group that already carries the name and adds the workspace to it", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: ["workspace-zero"] }] });
  const id = await service.ensure("companion", "workspace-one");
  assert.equal(id, "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.create"), false);
  const add = calls.find((call) => call[0] === "workspace.group.add");
  assert.deepEqual([add[1].group_id, add[1].workspace_id], ["group-old", "workspace-one"]);
});

test("does not add a workspace that is already a member", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: ["workspace-one"] }] });
  assert.equal(await service.ensure("companion", "workspace-one"), "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.add"), false);
});

test("reuses a known group id without listing every group", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: [] }] });
  const id = await service.ensure("companion", "workspace-one", { groupId: "group-old" });
  assert.equal(id, "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.create"), false);
});

test("returns null instead of throwing when cmux cannot list groups", async () => {
  const { service } = fake({ fail: "workspace.group.list" });
  assert.equal(await service.ensure("companion", "workspace-one"), null);
});

test("returns false instead of throwing when cmux cannot rename a group", async () => {
  const { service } = fake({ fail: "workspace.group.rename" });
  assert.equal(await service.rename("group-old", "companion — 2/5"), false);
});

test("returns null instead of throwing when cmux cannot create a group", async () => {
  const { service } = fake({ fail: "workspace.group.create" });
  assert.equal(await service.ensure("companion", "workspace-one"), null);
});

test("renames a group to carry the counter", async () => {
  const { service, calls } = fake();
  assert.equal(await service.rename("group-old", "Ship it — 2/5"), true);
  const rename = calls.find((call) => call[0] === "workspace.group.rename");
  assert.deepEqual([rename[1].group_id, rename[1].name], ["group-old", "Ship it — 2/5"]);
});

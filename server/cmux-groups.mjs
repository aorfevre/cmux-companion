const MAX_NAME = 80;

// A workspace group is how cmux shows that several sessions belong to one goal.
// Every method here is best-effort on purpose: a companion that cannot group a
// workspace must still launch it, and a cmux without group support must not
// turn a working delivery into a failed one.
export class CmuxGroups {
  constructor({ cmux, log = null } = {}) {
    if (!cmux) throw new TypeError("A cmux client is required");
    this.cmux = cmux;
    this.log = log;
  }

  // Returns the group id, or null when cmux could not be reached. `groupId` is
  // a hint from a stored plan: it saves a list call, and a stale one falls back
  // to the name lookup rather than failing.
  async ensure(name, workspaceId, { groupId = null } = {}) {
    const label = clamp(name);
    if (!label || !workspaceId) return null;
    try {
      const groups = await this.#list();
      const found = (groupId && groups.find((group) => group.id === groupId))
        || groups.find((group) => String(group.name || "") === label);
      // return await, not return: a bare return hands the promise to the
      // caller and escapes this catch.
      if (!found) return await this.#create(label, workspaceId);
      const members = Array.isArray(found.member_workspace_ids) ? found.member_workspace_ids : [];
      if (!members.includes(workspaceId)) {
        await this.cmux.rpc("workspace.group.add", { group_id: found.id, workspace_id: workspaceId });
      }
      return found.id;
    } catch (cause) {
      this.log?.warn?.({ err: cause, name: label }, "cmux group assignment failed");
      return null;
    }
  }

  async rename(groupId, name) {
    const label = clamp(name);
    if (!groupId || !label) return false;
    try {
      await this.cmux.rpc("workspace.group.rename", { group_id: groupId, name: label });
      return true;
    } catch (cause) {
      this.log?.warn?.({ err: cause, groupId }, "cmux group rename failed");
      return false;
    }
  }

  async #list() {
    const answer = await this.cmux.rpc("workspace.group.list", {});
    return Array.isArray(answer?.groups) ? answer.groups : [];
  }

  // create anchors the group on the workspaces it is given, so the first
  // workspace of a goal is what brings its group into existence.
  async #create(label, workspaceId) {
    const created = await this.cmux.rpc("workspace.group.create", { workspace_ids: [workspaceId] });
    const id = created?.group?.id || created?.group_id || null;
    if (!id) return null;
    await this.rename(id, label);
    return id;
  }
}

function clamp(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

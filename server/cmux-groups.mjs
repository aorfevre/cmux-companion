// NOT WIRED. Nothing constructs this service, and that is deliberate.
//
// Probed against real cmux: `workspace.group.create` honours no workspace
// parameter at all - `workspace_ids`, `workspace_id` and `{}` alike each seized
// two workspaces adjacent in the sidebar, not the one asked for. And
// `workspace.group.remove` dissolves the whole group instead of shrinking it,
// so a wrongly captured workspace cannot be evicted afterwards. Every goal
// launch would therefore drag two unrelated sessions into the goal's group and
// rename them with its counter, with no repair path.
//
// It is kept, with its tests, so grouping can be restored the day cmux offers a
// create that honours explicit membership. Until then, do not wire it back up.

export const MAX_NAME = 80;

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

  // Returns the group id, or null when cmux could not be reached. The display
  // name carries a live counter and is rewritten on every count change, so it
  // is never a stable key for a group we already own — only the stored
  // `groupId` is. A name lookup (exact, or by `prefix` when the name embeds a
  // counter) is purely the recovery path for when no id has been stored yet.
  async ensure(name, workspaceId, { groupId = null, prefix = "" } = {}) {
    const label = clamp(name);
    if (!label || !workspaceId) return null;
    try {
      const groups = await this.#list();
      const key = clamp(prefix);
      const byName = key
        ? (group) => String(group.name || "").startsWith(key)
        : (group) => String(group.name || "") === label;
      const found = (groupId && groups.find((group) => group.id === groupId))
        || groups.find(byName);
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
    const groups = Array.isArray(answer?.groups) ? answer.groups : [];
    // A primitive entry has no usable id, and would otherwise reach
    // workspace.group.add as group_id: undefined.
    return groups.filter((group) => group && typeof group === "object" && typeof group.id === "string");
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

// One goal, one group name, derived in one place. The planner names the group
// at launch and the integrator renames it on every count change; when the two
// derived it themselves they drifted, and a prefix lookup that drifts binds to
// the wrong group.
//
// The trailing delimiter is load-bearing: `ensure` matches with startsWith, so
// an undelimited prefix would capture any group whose name merely begins with
// the goal text - the shared repository group included. The plan id fragment is
// what keeps two goals sharing their opening words apart, exactly as it does in
// the integration branch name. Both halves are budgeted to stay inside
// MAX_NAME, because `clamp` truncating a prefix WIDENS its match instead of
// narrowing it.
const GROUP_SUFFIX_MAX = 20;
const GOAL_MAX = MAX_NAME - GROUP_SUFFIX_MAX - " \u2014".length - " 000000000".length;

export function goalGroupPrefix(plan) {
  const id = String(plan?.planId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "combined";
  // A goal with no readable text still needs a display half a user can read;
  // the id half already tells the two apart.
  const goal = oneLine(plan?.goal, GOAL_MAX) || "Goal";
  return `${goal} ${id} \u2014`;
}

// Always built on goalGroupPrefix, so the name a group is renamed to can never
// stop matching the prefix it is looked up by. That is what keeps one group per
// goal instead of a fresh one on every count change.
export function goalGroupName(plan, suffix) {
  return `${goalGroupPrefix(plan)} ${String(suffix || "").trim()}`.trim();
}

function oneLine(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

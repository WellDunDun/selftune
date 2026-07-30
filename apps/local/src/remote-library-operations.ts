import { dirname, join, resolve } from "node:path";

import type { CreateRemoteLibraryShareRequest } from "@selftune/runtime/dashboard-contract";
import { createRemoteLibraryHandle } from "@selftune/library/remote/transport";
import {
  actOnRemoteLibraryShare,
  createRemoteLibraryShare,
  createSkillShareGrant,
  listRemoteLibraryShares,
} from "@selftune/library/remote/sharing";
import {
  listWorkspaceSkillSetPolicies,
  resetWorkspaceSkillSetPolicy,
  updateWorkspaceSkillSetPolicy,
} from "@selftune/library/remote/policies";
import type {
  CreateSkillShareGrantRequest,
  WorkspaceSkillSetPolicyAction,
} from "@selftune/library/remote/types";
import {
  inviteWorkspaceMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "@selftune/library/remote/workspace";
import type { WorkspaceMemberRole } from "@selftune/library/remote/types";
import { loadRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import { writeWorkspaceSkillSetPolicyCache } from "@selftune/runtime/skill-set-remote-apply";
import {
  diagnoseRemote,
  exportRemoteLibrary,
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "@selftune/runtime/remote-library-sync";
import { CLIError } from "@selftune/runtime/utils/cli-error";

export type RemoteLibraryAction = "status" | "sync" | "export" | "restore";
export type RemoteLibraryShareAction = "list" | "create" | "accept" | "import" | "revoke";
export type RemoteWorkspaceAction =
  | "members"
  | "invite"
  | "role"
  | "remove"
  | "policies"
  | "policy_update"
  | "policy_reset";
export type RemoteWorkspaceInput =
  | { email: string; role: WorkspaceMemberRole }
  | { user_id: string; role?: WorkspaceMemberRole }
  | {
      skill_set_id: string;
      action?: WorkspaceSkillSetPolicyAction;
      reason?: string | null;
    };

export function makeRemoteLibraryOperations(configRootInput: string) {
  const configRoot = resolve(configRootInput);

  const run = async (action: RemoteLibraryAction) => {
    const config = loadRemoteLibraryConfig(configRoot);
    const handle = createRemoteLibraryHandle({
      baseUrl: config.url,
      apiKey: config.apiKey,
    });
    try {
      if (action === "status") {
        const [capabilities, head, diagnostics] = await Promise.all([
          handle.capabilities(),
          handle.head(),
          diagnoseRemote(handle),
        ]);
        return { url: config.url, capabilities, head, diagnostics };
      }
      if (action === "sync") {
        return syncRemoteLibrary({
          handle,
          configRoot,
          preferences: config.preferences,
        });
      }
      if (action === "export") {
        return exportRemoteLibrary({
          handle,
          outputPath: join(configRoot, "exports", `library-${Date.now()}.json`),
        });
      }
      return restoreRemoteLibrary({
        handle,
        targetRoot: join(dirname(configRoot), `selftune-library-restore-${Date.now()}`),
      });
    } finally {
      await handle.dispose();
    }
  };

  const backupSkill = async (skillId: string) => {
    const config = loadRemoteLibraryConfig(configRoot);
    const handle = createRemoteLibraryHandle({
      baseUrl: config.url,
      apiKey: config.apiKey,
    });
    try {
      const result = await syncRemoteLibrary({
        handle,
        configRoot,
        preferences: {
          releasedSkills: false,
          drafts: false,
          skillSets: false,
          metadata: false,
          decisionHistory: false,
        },
        selectedSkillIds: [skillId],
      });
      const [artifact] = result.syncedArtifacts;
      if (
        result.syncedArtifacts.length !== 1 ||
        !artifact ||
        artifact.artifactType !== "skill_revision" ||
        !artifact.artifactId.startsWith("backup-skill/")
      ) {
        throw new CLIError(
          `Sync & Backup did not return one immutable revision for skill "${skillId}".`,
          "GUARD_BLOCKED",
          "Refresh the Skill Manager catalog and retry the share.",
        );
      }
      return {
        ...result,
        subject: {
          skillId,
          snapshotId: result.snapshot.snapshotId,
          artifactId: artifact.artifactId,
        },
      };
    } finally {
      await handle.dispose();
    }
  };

  const share = async (
    action: RemoteLibraryShareAction,
    input?: CreateRemoteLibraryShareRequest | CreateSkillShareGrantRequest | { share_id: string },
  ) => {
    const config = loadRemoteLibraryConfig(configRoot);
    if (action === "list") return listRemoteLibraryShares(config);
    if (action === "create") {
      if (input && "mode" in input) return createSkillShareGrant(config, input);
      if (!input || !("recipient_email" in input)) {
        throw new CLIError("Private share details are required.", "MISSING_FLAG");
      }
      return createRemoteLibraryShare(config, input);
    }
    if (!input || !("share_id" in input)) {
      throw new CLIError("Private share ID is required.", "MISSING_FLAG");
    }
    return actOnRemoteLibraryShare(config, input.share_id, action);
  };

  const policies = async () => {
    const config = loadRemoteLibraryConfig(configRoot);
    const result = await listWorkspaceSkillSetPolicies(config);
    writeWorkspaceSkillSetPolicyCache(configRoot, result.policies, result.current_role);
    return result;
  };

  const setPolicy = async (
    skillSetId: string,
    input: { action: WorkspaceSkillSetPolicyAction; reason?: string | null },
  ) => {
    const config = loadRemoteLibraryConfig(configRoot);
    return updateWorkspaceSkillSetPolicy(config, skillSetId, input);
  };

  const resetPolicy = async (skillSetId: string) => {
    const config = loadRemoteLibraryConfig(configRoot);
    return resetWorkspaceSkillSetPolicy(config, skillSetId);
  };

  const workspace = async (action: RemoteWorkspaceAction, input?: RemoteWorkspaceInput) => {
    const config = loadRemoteLibraryConfig(configRoot);
    if (action === "members") return listWorkspaceMembers(config);
    if (action === "policies") return policies();
    if (action === "policy_update" || action === "policy_reset") {
      if (!input || !("skill_set_id" in input))
        throw new CLIError("Workspace Skill Set is required.", "MISSING_FLAG");
      if (action === "policy_reset") return resetPolicy(input.skill_set_id);
      if (!input.action) throw new CLIError("Workspace policy action is required.", "MISSING_FLAG");
      return setPolicy(input.skill_set_id, {
        action: input.action,
        reason: input.reason,
      });
    }
    if (action === "invite") {
      if (!input || !("email" in input))
        throw new CLIError("Invite details are required.", "MISSING_FLAG");
      return inviteWorkspaceMember(config, input);
    }
    if (!input || !("user_id" in input))
      throw new CLIError("Workspace member is required.", "MISSING_FLAG");
    if (action === "role") {
      if (!input.role) throw new CLIError("Workspace role is required.", "MISSING_FLAG");
      return updateWorkspaceMemberRole(config, input.user_id, input.role);
    }
    return removeWorkspaceMember(config, input.user_id);
  };

  return {
    run,
    backupSkill,
    share,
    policies,
    setPolicy,
    resetPolicy,
    workspace,
  };
}

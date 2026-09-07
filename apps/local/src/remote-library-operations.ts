import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type { CreateRemoteLibraryShareRequest } from "@selftune/runtime/dashboard-contract";
import { createRemoteLibraryHandle } from "@selftune/library/remote/transport";
import {
  createSelfHostedSkillSetPack,
  actOnRemoteLibraryShare,
  createRemoteLibraryShare,
  createSkillShareGrant,
  listSkillSetPacks,
  listRemoteLibraryShares,
  revokeSkillSetPack,
} from "@selftune/library/remote/sharing";
import { exportPortableSkillSetPackBytes } from "@selftune/library";
import { RemoteArtifact } from "@selftune/control-plane";
import { syncRemoteObjects } from "@selftune/library/remote/sync";
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
  getWorkspaceTeamOverview,
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
import { DEFAULT_CLOUD_API_URL } from "@selftune/runtime/auth/device-code";

export type RemoteLibraryAction = "status" | "sync" | "export" | "restore";
export type RemoteLibraryShareAction = "list" | "create" | "accept" | "import" | "revoke";
export type RemoteWorkspaceAction =
  | "overview"
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

export class RemoteLibraryService extends Context.Service<
  RemoteLibraryService,
  ReturnType<typeof makeRemoteLibraryOperations>
>()("SelfTune/RemoteLibrary") {}

export function makeRemoteLibraryLayer(configRoot: string) {
  return Layer.sync(RemoteLibraryService)(() => makeRemoteLibraryOperations(configRoot));
}

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
      return await syncRemoteLibrary({
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
      if (input && "mode" in input) {
        if (!("skillSetId" in input)) return createSkillShareGrant(config, input);
        const cloud = new URL(config.url).origin === new URL(DEFAULT_CLOUD_API_URL).origin;
        if (cloud) return createSkillShareGrant(config, input);
        const bytes = exportPortableSkillSetPackBytes(input.skillSetId, { configRoot });
        const objectHash = createHash("sha256").update(bytes).digest("hex");
        const handle = createRemoteLibraryHandle({ baseUrl: config.url, apiKey: config.apiKey });
        try {
          const artifactId = `skill-set/${input.skillSetId}/${objectHash}`;
          const synced = await syncRemoteObjects({
            handle,
            objects: [
              {
                bytes,
                artifact: RemoteArtifact.make({
                  artifactId,
                  artifactType: "skill_set",
                  objectHash,
                  revisionHash: objectHash,
                  updatedAt: new Date().toISOString(),
                }),
              },
            ],
          });
          if (input.delivery === "email") {
            const share = await createRemoteLibraryShare(config, {
              snapshot_id: synced.snapshot.snapshotId,
              artifact_id: artifactId,
              recipient_email: input.recipientEmail,
            });
            return {
              shareId: share.id,
              mode: "private_single_claim" as const,
              delivery: "email" as const,
              shareUrl: null,
              expiresAt: share.expires_at ?? "",
            };
          }
          return createSelfHostedSkillSetPack(config, {
            snapshot_id: synced.snapshot.snapshotId,
            artifact_id: artifactId,
            mode: input.mode,
          });
        } finally {
          await handle.dispose();
        }
      }
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

  const listPacks = async () => {
    const config = loadRemoteLibraryConfig(configRoot);
    return listSkillSetPacks(config);
  };

  const revokePack = async (packId: string) => {
    const config = loadRemoteLibraryConfig(configRoot);
    await revokeSkillSetPack(config, packId);
    return { packId, status: "revoked" as const };
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
    if (action === "overview") return getWorkspaceTeamOverview(config);
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
    listPacks,
    revokePack,
    policies,
    setPolicy,
    resetPolicy,
    workspace,
  };
}

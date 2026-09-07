import * as Schema from "effect/Schema";
import { remoteRequest, SuccessResponse } from "./http.js";
import {
  type RemoteLibraryConnection,
  WorkspaceSkillSetPoliciesResponse,
  WorkspaceSkillSetPolicy,
  type WorkspaceSkillSetPolicyAction,
} from "./types.js";

const policy = {
  failureMessage: "Workspace policy request failed",
  invalidMessage: "Workspace policy response was invalid.",
  blockedStatuses: [401, 403],
  retryServerErrors: true,
};

export function listWorkspaceSkillSetPolicies(config: RemoteLibraryConnection) {
  return remoteRequest(
    config,
    "/api/v1/remote-library/policies",
    WorkspaceSkillSetPoliciesResponse,
    policy,
  );
}

export async function updateWorkspaceSkillSetPolicy(
  config: RemoteLibraryConnection,
  skillSetId: string,
  input: { action: WorkspaceSkillSetPolicyAction; reason?: string | null },
): Promise<WorkspaceSkillSetPolicy> {
  const result = await remoteRequest(
    config,
    `/api/v1/remote-library/policies/${encodeURIComponent(skillSetId)}`,
    Schema.Struct({ policy: WorkspaceSkillSetPolicy }),
    policy,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.policy;
}

export function resetWorkspaceSkillSetPolicy(config: RemoteLibraryConnection, skillSetId: string) {
  return remoteRequest(
    config,
    `/api/v1/remote-library/policies/${encodeURIComponent(skillSetId)}`,
    SuccessResponse,
    policy,
    { method: "DELETE" },
  );
}

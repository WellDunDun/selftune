import * as Schema from "effect/Schema";
import { remoteRequest, SuccessResponse } from "./http.js";
import {
  type RemoteLibraryConnection,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
  WorkspaceTeamOverview,
} from "./types.js";

const policy = {
  failureMessage: "Workspace member request failed",
  invalidMessage: "Workspace member response was invalid.",
  blockedStatuses: [401, 403],
  timeoutMs: 5_000,
};

export function listWorkspaceMembers(config: RemoteLibraryConnection) {
  return remoteRequest(config, "/api/v1/teams/members", WorkspaceMembersResponse, policy);
}

export function getWorkspaceTeamOverview(config: RemoteLibraryConnection) {
  return remoteRequest(config, "/api/v1/teams/overview", WorkspaceTeamOverview, policy);
}

export function inviteWorkspaceMember(
  config: RemoteLibraryConnection,
  input: { email: string; role: WorkspaceMemberRole },
) {
  return remoteRequest(
    config,
    "/api/v1/teams/invite",
    Schema.Struct({
      status: Schema.Literals(["invited", "joined"]),
      user_id: Schema.NullOr(Schema.String),
      email: Schema.String,
      role: WorkspaceMemberRole,
    }),
    policy,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateWorkspaceMemberRole(
  config: RemoteLibraryConnection,
  userId: string,
  role: WorkspaceMemberRole,
) {
  return remoteRequest(
    config,
    `/api/v1/teams/members/${encodeURIComponent(userId)}/role`,
    SuccessResponse,
    policy,
    { method: "PUT", body: JSON.stringify({ role }) },
  );
}

export function removeWorkspaceMember(config: RemoteLibraryConnection, userId: string) {
  return remoteRequest(
    config,
    `/api/v1/teams/members/${encodeURIComponent(userId)}`,
    SuccessResponse,
    policy,
    { method: "DELETE" },
  );
}

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { RemoteWorkspaceAction, RemoteWorkspaceInput } from "../remote-library-operations.js";
import { DashboardOperationError } from "../dashboard-operation-errors.js";
import { dashboardCorsHeaders, sameOriginFailure } from "../dashboard-http.js";

const WorkspaceSkillSetPolicyBody = Schema.Struct({
  action: Schema.Literals(["allow", "require_approval", "block", "require"]),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const WorkspaceInviteBody = Schema.Struct({
  email: Schema.String,
  role: Schema.Literals(["viewer", "member", "admin", "owner"]),
});
const WorkspaceRoleBody = Schema.Struct({
  role: Schema.Literals(["viewer", "member", "admin", "owner"]),
});

interface WorkspaceOperations {
  readonly workspace: (
    action: RemoteWorkspaceAction,
    input?: RemoteWorkspaceInput,
  ) => Effect.Effect<unknown, DashboardOperationError>;
}

function requestError(operation: string, message: string): DashboardOperationError {
  return DashboardOperationError.make({
    operation,
    code: "MISSING_FLAG",
    message,
    status: 400,
    retryable: false,
  });
}

const decodeBody = Effect.fn("WorkspaceSettings.decodeBody")(function* <S extends Schema.Top>(
  operation: string,
  request: Request,
  schema: S,
  message: string,
) {
  const input = yield* Effect.tryPromise({
    try: (): Promise<unknown> => request.json(),
    catch: () => requestError(operation, message),
  });
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => requestError(operation, message)),
  );
});

function json(value: unknown): Response {
  return Response.json(value, { headers: dashboardCorsHeaders() });
}

function decodeIdentifier(
  operation: string,
  value: string,
): Effect.Effect<string, DashboardOperationError> {
  return Effect.try({
    try: () => decodeURIComponent(value),
    catch: () => requestError(operation, "The workspace identifier is malformed."),
  });
}

export const routeWorkspaceSettings = Effect.fn("WorkspaceSettings.route")(function* (
  request: Request,
  url: URL,
  allowedOrigins: ReadonlySet<string>,
  operations: WorkspaceOperations,
) {
  if (url.pathname === "/api/v2/settings/workspace/policies" && request.method === "GET") {
    return json(yield* operations.workspace("policies"));
  }
  if (url.pathname === "/api/v2/settings/workspace/members" && request.method === "GET") {
    return json(yield* operations.workspace("members"));
  }
  if (url.pathname === "/api/v2/settings/workspace/invite" && request.method === "POST") {
    const unauthorized = sameOriginFailure(request, allowedOrigins);
    if (unauthorized) return unauthorized;
    const body = yield* decodeBody(
      "workspace.invite",
      request,
      WorkspaceInviteBody,
      "A member email and role are required.",
    );
    return json(yield* operations.workspace("invite", body));
  }

  const memberMatch = url.pathname.match(
    /^\/api\/v2\/settings\/workspace\/members\/([^/]+)\/(role|remove)$/,
  );
  if (memberMatch && request.method === "POST") {
    const unauthorized = sameOriginFailure(request, allowedOrigins);
    if (unauthorized) return unauthorized;
    const userId = yield* decodeIdentifier("workspace.member", memberMatch[1] ?? "");
    if (memberMatch[2] === "remove") {
      return json(yield* operations.workspace("remove", { user_id: userId }));
    }
    const body = yield* decodeBody(
      "workspace.role",
      request,
      WorkspaceRoleBody,
      "A workspace role is required.",
    );
    return json(yield* operations.workspace("role", { user_id: userId, role: body.role }));
  }

  const policyMatch = url.pathname.match(
    /^\/api\/v2\/settings\/workspace\/policies\/([^/]+)(?:\/(reset))?$/,
  );
  if (policyMatch && request.method === "POST") {
    const unauthorized = sameOriginFailure(request, allowedOrigins);
    if (unauthorized) return unauthorized;
    const skillSetId = yield* decodeIdentifier("workspace_policies.update", policyMatch[1] ?? "");
    if (policyMatch[2] === "reset") {
      return json(yield* operations.workspace("policy_reset", { skill_set_id: skillSetId }));
    }
    const body = yield* decodeBody(
      "workspace_policies.update",
      request,
      WorkspaceSkillSetPolicyBody,
      "A policy action is required.",
    );
    return json(
      yield* operations.workspace("policy_update", {
        skill_set_id: skillSetId,
        action: body.action,
        reason: body.reason,
      }),
    );
  }
  return null;
});

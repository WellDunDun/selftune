import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { renderSkillSetPackLandingPage, SkillSetPackPreview } from "@selftune/control-plane";

import type { SelfHostConfig } from "./config.js";
import {
  CreatePackRequest,
  CreateShareRequest,
  CreateSnapshotRequest,
  ContributorSignalPayload,
  DesktopManifestPayload,
  isSha256,
  isUuid,
  type SelfHostUser,
  type UserRole,
} from "./contract.js";
import { SelfHostFailure, SelfHostRepository, SelfHostRepositoryLive } from "./repository.js";

const API_PREFIX = "/api/v1/remote-library";

const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  viewer: 0,
  member: 1,
  admin: 2,
};

function failure(
  code: string,
  status: number,
  message: string,
  details: Readonly<Record<string, string | null>> = {},
): SelfHostFailure {
  return SelfHostFailure.make({ code, status, message, details });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function requireRole(user: SelfHostUser, minimum: UserRole): Effect.Effect<void, SelfHostFailure> {
  if (ROLE_RANK[user.role] >= ROLE_RANK[minimum]) return Effect.void;
  return Effect.fail(
    failure("RemoteLibraryPermissionDenied", 403, `This operation requires the ${minimum} role.`),
  );
}

const decodeSnapshotRequest = Effect.fn("SelfHostApi.decodeSnapshot")(function* (request: Request) {
  const input = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => failure("RemoteLibraryInvalidSnapshot", 400, "Invalid Remote Library snapshot"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateSnapshotRequest))(
    input,
  ).pipe(
    Effect.mapError(() =>
      failure("RemoteLibraryInvalidSnapshot", 400, "Invalid Remote Library snapshot"),
    ),
  );
});

const decodeShareRequest = Effect.fn("SelfHostApi.decodeShare")(function* (request: Request) {
  const input = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => failure("RemoteLibraryInvalidShare", 400, "Invalid private share"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateShareRequest))(input).pipe(
    Effect.mapError(() => failure("RemoteLibraryInvalidShare", 400, "Invalid private share")),
  );
});

const decodePackRequest = Effect.fn("SelfHostApi.decodePack")(function* (request: Request) {
  const input = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => failure("RemoteLibraryInvalidPack", 400, "Invalid Skill Set Pack request"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreatePackRequest))(input).pipe(
    Effect.mapError(() =>
      failure("RemoteLibraryInvalidPack", 400, "Invalid Skill Set Pack request"),
    ),
  );
});

const decodeContribution = Effect.fn("SelfHostApi.decodeContribution")(function* (
  request: Request,
) {
  const input = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => failure("ContributorSignalInvalid", 400, "Invalid contributor signal"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ContributorSignalPayload))(
    input,
  ).pipe(
    Effect.mapError(() => failure("ContributorSignalInvalid", 400, "Invalid contributor signal")),
  );
});

const decodeDesktopManifest = Effect.fn("SelfHostApi.decodeDesktopManifest")(function* (
  request: Request,
) {
  const input = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => failure("HostedManifestInvalid", 400, "Invalid Desktop manifest"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopManifestPayload))(
    input,
  ).pipe(Effect.mapError(() => failure("HostedManifestInvalid", 400, "Invalid Desktop manifest")));
});

function objectHeaders(object: {
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}): HeadersInit {
  return {
    "Content-Length": String(object.sizeBytes),
    "Content-Type": object.contentType,
    ETag: `"${object.sha256}"`,
    "X-SelfTune-Content-Sha256": object.sha256,
  };
}

function errorResponse(error: SelfHostFailure): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (
    error.code === "RemoteLibraryObjectMissing" &&
    error.status === 422 &&
    error.details.object_sha256
  ) {
    headers.set("X-SelfTune-Missing-Object", error.details.object_sha256);
  }
  if (error.status === 401) headers.set("WWW-Authenticate", "Bearer");
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...error.details,
      },
    },
    { status: error.status, headers },
  );
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return "invalid";
  }
}

function withCors(response: Response, request: Request, config: SelfHostConfig): Response {
  const origin = requestOrigin(request);
  if (!origin || !config.allowedOrigins.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Max-Age", "600");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function validateOrigin(
  request: Request,
  config: SelfHostConfig,
): Effect.Effect<void, SelfHostFailure> {
  const origin = requestOrigin(request);
  if (origin === null || config.allowedOrigins.includes(origin)) return Effect.void;
  return Effect.fail(
    failure(
      "RemoteLibraryOriginDenied",
      403,
      "Request origin is not allowed by this SelfTune host.",
    ),
  );
}

const routeRequest = Effect.fn("SelfHostApi.route")(function* (
  request: Request,
  config: SelfHostConfig,
) {
  yield* validateOrigin(request, config);
  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const repository = yield* SelfHostRepository;
  const token = bearerToken(request);
  if (!token) {
    return yield* Effect.fail(
      failure("AUTH_MISSING", 401, "A valid Remote Library bearer token is required."),
    );
  }
  const user = yield* repository.authenticate(token);
  if (!user) {
    return yield* Effect.fail(
      failure("AUTH_INVALID", 401, "The Remote Library bearer token is not valid."),
    );
  }

  if (path === "/capabilities" && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json({
      protocol: "selftune.remote-library.v1",
      snapshot_schema: "selftune.remote-library.snapshot.v1",
      immutable_objects: true,
      compare_and_swap_heads: true,
      artifact_types: [
        "skill_revision",
        "draft_revision",
        "skill_set",
        "decision_history",
        "evidence_summary",
      ],
      raw_transcripts_synced: false,
      max_object_bytes: config.maxObjectBytes,
      hosted_state: {
        accounts: true,
        devices: true,
        privacy_safe_manifests: true,
        private_sharing: true,
        contributor_signals: true,
        audit: true,
        billing: false,
        cross_customer_saas: false,
      },
    });
  }

  const objectMatch = path.match(/^\/objects\/([^/]+)$/);
  const objectSha256 = objectMatch?.[1];
  if (objectSha256 && ["GET", "HEAD", "PUT"].includes(request.method)) {
    if (!isSha256(objectSha256)) {
      return yield* Effect.fail(
        failure(
          "RemoteLibraryInvalidObject",
          400,
          "Object SHA-256 must be 64 lowercase hex characters",
        ),
      );
    }
    if (request.method === "PUT") {
      yield* requireRole(user, "admin");
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > config.maxObjectBytes) {
        return yield* Effect.fail(
          failure(
            "RemoteLibraryObjectTooLarge",
            413,
            "Remote Library object exceeds the server limit",
          ),
        );
      }
      const bytes = new Uint8Array(
        yield* Effect.tryPromise({
          try: () => request.arrayBuffer(),
          catch: (error) =>
            failure("RemoteLibraryInvalidObject", 400, "Unable to read object body", {
              cause: error instanceof Error ? error.message : String(error),
            }),
        }),
      );
      const result = yield* repository.putObject(
        user,
        objectSha256,
        bytes,
        request.headers.get("content-type") ?? "application/octet-stream",
      );
      return Response.json(
        {
          sha256: result.sha256,
          size_bytes: result.sizeBytes,
          content_type: result.contentType,
          created: result.created,
        },
        { status: result.created ? 201 : 200 },
      );
    }
    yield* requireRole(user, "viewer");
    const object =
      request.method === "HEAD"
        ? yield* repository.hasObject(user, objectSha256)
        : yield* repository.getObject(user, objectSha256);
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: objectHeaders(object) });
    }
    return new Response(new Blob([Uint8Array.from(object.bytes)]), {
      headers: objectHeaders(object),
    });
  }

  if (path === "/snapshots" && request.method === "POST") {
    yield* requireRole(user, "admin");
    const snapshot = yield* repository.commitSnapshot(user, yield* decodeSnapshotRequest(request));
    return Response.json({ snapshot }, { status: 201 });
  }

  if (path === "/snapshots/head" && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json({ snapshot: yield* repository.getHead(user) });
  }

  const snapshotMatch = path.match(/^\/snapshots\/([^/]+)$/);
  const snapshotId = snapshotMatch?.[1];
  if (snapshotId && request.method === "GET") {
    yield* requireRole(user, "viewer");
    if (!isUuid(snapshotId)) {
      return yield* Effect.fail(
        failure("RemoteLibraryInvalidSnapshot", 400, "Snapshot ID must be a UUID"),
      );
    }
    return Response.json({ snapshot: yield* repository.getSnapshot(user, snapshotId) });
  }

  if (path === "/diagnostics" && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json(yield* repository.diagnostics(user));
  }

  if (path === "/shares" && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json(yield* repository.listShares(user));
  }

  if (path === "/shares" && request.method === "POST") {
    yield* requireRole(user, "admin");
    const share = yield* repository.createShare(user, yield* decodeShareRequest(request));
    return Response.json({ share }, { status: 201 });
  }

  if (path === "/packs" && request.method === "POST") {
    yield* requireRole(user, "admin");
    const issued = yield* repository.createPack(user, yield* decodePackRequest(request));
    return Response.json(
      {
        protocol: "selftune.skill-set-pack.v1",
        packId: issued.id,
        mode: issued.mode,
        packUrl: `${config.publicUrl.replace(/\/$/, "")}/p/${issued.token}`,
        expiresAt: issued.expiresAt,
        skillSetRevisionSha256: issued.skillSetRevisionSha256,
        objectSha256: issued.objectSha256,
      },
      { status: 201 },
    );
  }

  if (path === "/packs" && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json(yield* repository.listPacks(user));
  }

  const packMatch = path.match(/^\/packs\/([^/]+)$/);
  const packId = packMatch?.[1];
  if (packId && request.method === "DELETE") {
    yield* requireRole(user, "admin");
    return Response.json(yield* repository.revokePack(user, packId));
  }

  const shareMatch = path.match(/^\/shares\/([^/]+)$/);
  const shareId = shareMatch?.[1];
  if (shareId && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json({ share: yield* repository.getShare(user, shareId) });
  }

  const shareActionMatch = path.match(/^\/shares\/([^/]+)\/(accept|import|revoke)$/);
  const actionShareId = shareActionMatch?.[1];
  const action = shareActionMatch?.[2];
  if (actionShareId && action && request.method === "POST") {
    if (!isUuid(actionShareId)) {
      return yield* Effect.fail(
        failure("RemoteLibraryInvalidShare", 400, "Share ID must be a UUID"),
      );
    }
    if (action === "accept") {
      yield* requireRole(user, "member");
      return Response.json({ share: yield* repository.acceptShare(user, actionShareId) });
    }
    if (action === "import") {
      yield* requireRole(user, "member");
      return Response.json(yield* repository.importShare(user, actionShareId));
    }
    yield* requireRole(user, "admin");
    return Response.json({ share: yield* repository.revokeShare(user, actionShareId) });
  }

  return yield* Effect.fail(
    failure("RemoteLibraryRouteNotFound", 404, "Remote Library endpoint not found."),
  );
});

const routeContributionRequest = Effect.fn("SelfHostApi.contributions")(function* (
  request: Request,
) {
  const repository = yield* SelfHostRepository;
  const token = bearerToken(request);
  if (!token) {
    return yield* Effect.fail(
      failure("AUTH_MISSING", 401, "A valid SelfTune bearer token is required."),
    );
  }
  const user = yield* repository.authenticate(token);
  if (!user) {
    return yield* Effect.fail(
      failure("AUTH_INVALID", 401, "The SelfTune bearer token is not valid."),
    );
  }
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/contributions/relay" && request.method === "POST") {
    const status = yield* repository.receiveContribution(user, yield* decodeContribution(request));
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  }
  const aggregate = /^\/api\/v1\/contributions\/aggregates\/(sk_sha256_[a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (aggregate?.[1] && request.method === "GET") {
    yield* requireRole(user, "viewer");
    return Response.json(yield* repository.contributionAggregate(user, aggregate[1]), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  return yield* Effect.fail(
    failure("ContributorRouteNotFound", 404, "Contributor signal endpoint not found."),
  );
});

const routeHostedStateRequest = Effect.fn("SelfHostApi.hostedState")(function* (request: Request) {
  const repository = yield* SelfHostRepository;
  const token = bearerToken(request);
  if (!token) {
    return yield* Effect.fail(
      failure("AUTH_MISSING", 401, "A valid SelfTune bearer token is required."),
    );
  }
  const user = yield* repository.authenticate(token);
  if (!user) {
    return yield* Effect.fail(
      failure("AUTH_INVALID", 401, "The SelfTune bearer token is not valid."),
    );
  }
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/desktop/state" && request.method === "GET") {
    return Response.json(yield* repository.hostedState(user), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/api/v1/desktop/manifest" && request.method === "POST") {
    return Response.json(
      yield* repository.publishManifest(user, yield* decodeDesktopManifest(request)),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return yield* Effect.fail(
    failure("HostedStateRouteNotFound", 404, "Hosted-state endpoint not found."),
  );
});

const checkReadiness = Effect.fn("SelfHostApi.checkReadiness")(function* (
  accounts: SelfHostConfig["accounts"],
) {
  const repository = yield* SelfHostRepository;
  const checkedOrganizations = new Set<string>();
  for (const account of accounts) {
    const user = yield* repository.authenticate(account.token);
    if (!user) {
      return yield* failure(
        "RemoteLibraryUnavailable",
        503,
        "Remote Library storage is unavailable.",
      );
    }
    if (checkedOrganizations.has(user.orgId)) continue;
    checkedOrganizations.add(user.orgId);
    const diagnostics = yield* repository.diagnostics(user);
    if (diagnostics.status === "degraded") {
      return yield* failure(
        "RemoteLibraryIntegrityDegraded",
        503,
        "Remote Library integrity checks are degraded.",
      );
    }
  }
});

const routePublicPackRequest = Effect.fn("SelfHostApi.publicPack")(function* (request: Request) {
  const url = new URL(request.url);
  const match = /^\/api\/v1\/public\/packs\/([A-Za-z0-9_-]{43})(\/content)?$/.exec(url.pathname);
  if (!match || request.method !== "GET") {
    return yield* failure("RemoteLibraryRouteNotFound", 404, "Pack endpoint not found.");
  }
  const repository = yield* SelfHostRepository;
  const token = match[1]!;
  if (!match[2]) {
    return Response.json(yield* repository.previewPack(token), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  const content = yield* repository.getPackContent(token);
  return new Response(new Blob([Uint8Array.from(content.bytes)]), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(content.bytes.byteLength),
      "Content-Type": content.contentType,
      "X-SelfTune-Content-Sha256": content.objectSha256,
    },
  });
});

export interface RemoteApiHandle {
  readonly dispose: () => Promise<void>;
  readonly handle: (request: Request) => Promise<Response | null>;
  readonly ready: Promise<void>;
}

export function makeRemoteApi(config: SelfHostConfig): RemoteApiHandle {
  const runtime = ManagedRuntime.make(SelfHostRepositoryLive(config));
  const ready = runtime.context().then(() => undefined);
  void ready.catch(() => undefined);

  const unavailable = (): Response =>
    errorResponse(
      failure("RemoteLibraryUnavailable", 503, "Remote Library storage is unavailable."),
    );

  return {
    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS" && url.pathname.startsWith(`${API_PREFIX}/`)) {
        const origin = requestOrigin(request);
        if (!origin || !config.allowedOrigins.includes(origin)) {
          return errorResponse(
            failure(
              "RemoteLibraryOriginDenied",
              403,
              "Request origin is not allowed by this SelfTune host.",
            ),
          );
        }
        return withCors(new Response(null, { status: 204 }), request, config);
      }
      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json(
          { ok: true, service: "selftune-selfhost", check: "liveness" },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (url.pathname === "/readyz" && request.method === "GET") {
        try {
          await ready;
        } catch {
          return unavailable();
        }
        try {
          const result = await runtime.runPromise(Effect.result(checkReadiness(config.accounts)));
          if (result._tag === "Failure") {
            return result.failure.code === "RemoteLibraryIntegrityDegraded"
              ? errorResponse(result.failure)
              : unavailable();
          }
          return Response.json(
            { ok: true, service: "selftune-selfhost", check: "readiness" },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch {
          return unavailable();
        }
      }
      const landingMatch = /^\/p\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (landingMatch && request.method === "GET") {
        const landingToken = landingMatch[1] ?? "";
        const brandedUrl = `${config.publicUrl.replace(/\/$/, "")}/p/${landingToken}`;
        try {
          await ready;
          const preview = await runtime.runPromise(
            Effect.flatMap(SelfHostRepository, (repository) =>
              repository.previewPack(landingToken),
            ),
          );
          return new Response(
            renderSkillSetPackLandingPage({
              packUrl: brandedUrl,
              preview: new SkillSetPackPreview(preview),
            }),
            {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
              },
            },
          );
        } catch {
          return new Response("Pack unavailable", {
            status: 404,
            headers: { "Cache-Control": "no-store" },
          });
        }
      }
      if (url.pathname.startsWith("/api/v1/public/packs/")) {
        try {
          await ready;
          const result = await runtime.runPromise(Effect.result(routePublicPackRequest(request)));
          return result._tag === "Failure" ? errorResponse(result.failure) : result.success;
        } catch {
          return unavailable();
        }
      }
      if (url.pathname.startsWith("/api/v1/contributions/")) {
        try {
          await ready;
          const result = await runtime.runPromise(Effect.result(routeContributionRequest(request)));
          return withCors(
            result._tag === "Failure" ? errorResponse(result.failure) : result.success,
            request,
            config,
          );
        } catch {
          return withCors(unavailable(), request, config);
        }
      }
      if (url.pathname === "/api/v1/desktop/state" || url.pathname === "/api/v1/desktop/manifest") {
        try {
          await ready;
          const result = await runtime.runPromise(Effect.result(routeHostedStateRequest(request)));
          return withCors(
            result._tag === "Failure" ? errorResponse(result.failure) : result.success,
            request,
            config,
          );
        } catch {
          return withCors(unavailable(), request, config);
        }
      }
      if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return null;
      try {
        await ready;
      } catch {
        return withCors(unavailable(), request, config);
      }
      try {
        const result = await runtime.runPromise(Effect.result(routeRequest(request, config)));
        return withCors(
          result._tag === "Failure" ? errorResponse(result.failure) : result.success,
          request,
          config,
        );
      } catch {
        return withCors(unavailable(), request, config);
      }
    },
    dispose: () => runtime.dispose(),
    ready,
  };
}

import { Database } from "bun:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodePortableSkillSetEnvelope } from "@selftune/control-plane";

import type { SelfHostConfig } from "./config.js";
import {
  type CreatePackRequest,
  type CreateShareRequest,
  type CreateSnapshotRequest,
  type ContributorSignalAggregate,
  type ContributorSignalPayload,
  type DesktopManifestPayload,
  isSha256,
  isUuid,
  type RemoteArtifact,
  RemoteArtifact as RemoteArtifactSchema,
  type RemoteArtifactType,
  type RemoteDiagnostics,
  type RemoteShare,
  type RemoteShareStatus,
  type RemoteSnapshot,
  type SelfHostUser,
  type SelfHostPackManagementItem,
  type SelfHostPackPreview,
  SharedSetManifest,
  type UserRole,
} from "./contract.js";

const ArtifactArray = Schema.Array(RemoteArtifactSchema);
const decodeArtifacts = Schema.decodeUnknownSync(ArtifactArray);
const decodeSetManifest = Schema.decodeUnknownSync(SharedSetManifest);

export class SelfHostFailure extends Schema.TaggedErrorClass<SelfHostFailure>()("SelfHostFailure", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
  details: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
}) {}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PutObjectResult {
  readonly contentType: string;
  readonly created: boolean;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ShareImportResult {
  readonly share: RemoteShare;
  readonly snapshot: RemoteSnapshot | null;
}

export interface PackIssueResult {
  readonly id: string;
  readonly token: string;
  readonly mode: "reusable_unlisted" | "private_single_claim";
  readonly expiresAt: string;
  readonly objectSha256: string;
  readonly skillSetRevisionSha256: string;
}

export interface PackContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly objectSha256: string;
}

interface RepositoryService {
  readonly hostedState: (user: SelfHostUser) => Effect.Effect<
    {
      readonly workspaceId: string;
      readonly plan: "free";
      readonly status: "none";
      readonly currentPeriodEnd: null;
    },
    SelfHostFailure
  >;
  readonly publishManifest: (
    user: SelfHostUser,
    payload: DesktopManifestPayload,
  ) => Effect.Effect<{ readonly uploaded: number; readonly unchanged: number }, SelfHostFailure>;
  readonly receiveContribution: (
    user: SelfHostUser,
    payload: ContributorSignalPayload,
  ) => Effect.Effect<"accepted" | "duplicate", SelfHostFailure>;
  readonly contributionAggregate: (
    user: SelfHostUser,
    skillHash: string,
  ) => Effect.Effect<ContributorSignalAggregate, SelfHostFailure>;
  readonly createPack: (
    user: SelfHostUser,
    request: CreatePackRequest,
  ) => Effect.Effect<PackIssueResult, SelfHostFailure>;
  readonly acceptShare: (
    user: SelfHostUser,
    shareId: string,
  ) => Effect.Effect<RemoteShare, SelfHostFailure>;
  readonly authenticate: (token: string) => Effect.Effect<SelfHostUser | null, SelfHostFailure>;
  readonly commitSnapshot: (
    user: SelfHostUser,
    request: CreateSnapshotRequest,
  ) => Effect.Effect<RemoteSnapshot, SelfHostFailure>;
  readonly createShare: (
    user: SelfHostUser,
    request: CreateShareRequest,
  ) => Effect.Effect<RemoteShare, SelfHostFailure>;
  readonly diagnostics: (user: SelfHostUser) => Effect.Effect<RemoteDiagnostics, SelfHostFailure>;
  readonly getPackContent: (token: string) => Effect.Effect<PackContent, SelfHostFailure>;
  readonly previewPack: (token: string) => Effect.Effect<SelfHostPackPreview, SelfHostFailure>;
  readonly listPacks: (
    user: SelfHostUser,
  ) => Effect.Effect<
    { readonly packs: ReadonlyArray<SelfHostPackManagementItem> },
    SelfHostFailure
  >;
  readonly getHead: (user: SelfHostUser) => Effect.Effect<RemoteSnapshot | null, SelfHostFailure>;
  readonly getObject: (
    user: SelfHostUser,
    sha256: string,
  ) => Effect.Effect<StoredObject, SelfHostFailure>;
  readonly getShare: (
    user: SelfHostUser,
    shareId: string,
  ) => Effect.Effect<RemoteShare, SelfHostFailure>;
  readonly getSnapshot: (
    user: SelfHostUser,
    snapshotId: string,
  ) => Effect.Effect<RemoteSnapshot, SelfHostFailure>;
  readonly hasObject: (
    user: SelfHostUser,
    sha256: string,
  ) => Effect.Effect<StoredObject, SelfHostFailure>;
  readonly importShare: (
    user: SelfHostUser,
    shareId: string,
  ) => Effect.Effect<ShareImportResult, SelfHostFailure>;
  readonly listShares: (
    user: SelfHostUser,
  ) => Effect.Effect<
    { readonly inbox: ReadonlyArray<RemoteShare>; readonly outbox: ReadonlyArray<RemoteShare> },
    SelfHostFailure
  >;
  readonly putObject: (
    user: SelfHostUser,
    sha256: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Effect.Effect<PutObjectResult, SelfHostFailure>;
  readonly revokeShare: (
    user: SelfHostUser,
    shareId: string,
  ) => Effect.Effect<RemoteShare, SelfHostFailure>;
  readonly revokePack: (
    user: SelfHostUser,
    packId: string,
  ) => Effect.Effect<{ readonly id: string; readonly revokedAt: string }, SelfHostFailure>;
}

export class SelfHostRepository extends Context.Service<SelfHostRepository, RepositoryService>()(
  "@selftune/selfhost/SelfHostRepository",
) {}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly org_id: string;
  readonly org_name: string;
  readonly role: UserRole;
}

interface ObjectRow {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
}

interface SnapshotRow {
  readonly id: string;
  readonly parent_snapshot_id: string | null;
  readonly artifacts_json: string;
  readonly created_at: string;
}

interface ShareRow {
  readonly id: string;
  readonly owner_org_id: string;
  readonly owner_org_name: string;
  readonly source_snapshot_id: string;
  readonly root_artifact_id: string;
  readonly root_artifact_type: RemoteArtifactType;
  readonly artifacts_json: string;
  readonly recipient_user_id: string;
  readonly recipient_email: string;
  readonly recipient_name: string | null;
  readonly created_by: string;
  readonly expires_at: string | null;
  readonly accepted_at: string | null;
  readonly imported_at: string | null;
  readonly imported_org_id: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PackRow {
  readonly id: string;
  readonly owner_org_id: string;
  readonly source_snapshot_id: string;
  readonly artifact_id: string;
  readonly object_sha256: string;
  readonly token_hash: string;
  readonly mode: "reusable_unlisted" | "private_single_claim";
  readonly expires_at: string;
  readonly claimed_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface CountRow {
  readonly count: number;
}

interface BytesRow {
  readonly total: number;
}

function failure(
  code: string,
  status: number,
  message: string,
  details: Readonly<Record<string, string | null>> = {},
): SelfHostFailure {
  return SelfHostFailure.make({ code, status, message, details });
}

function storageFailure(operation: string, cause: unknown): SelfHostFailure {
  if (cause instanceof SelfHostFailure) return cause;
  return failure("RemoteLibraryFailure", 503, "Remote Library operation failed", {
    operation,
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function derivedPackToken(packId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`selftune.skill-set-pack.v1:${packId}`)
    .digest("base64url");
}

function userFromRow(row: UserRow): SelfHostUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
  };
}

function snapshotFromRow(row: SnapshotRow): RemoteSnapshot {
  const parsed: unknown = JSON.parse(row.artifacts_json);
  return {
    id: row.id,
    parent_snapshot_id: row.parent_snapshot_id,
    schema_version: "selftune.remote-library.snapshot.v1",
    artifacts: decodeArtifacts(parsed),
    created_at: row.created_at,
  };
}

function shareStatus(row: ShareRow, now = new Date()): RemoteShareStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at) <= now) return "expired";
  if (row.imported_at) return "imported";
  if (row.accepted_at) return "accepted";
  return "pending";
}

function shareFromRow(row: ShareRow): RemoteShare {
  const parsed: unknown = JSON.parse(row.artifacts_json);
  return {
    id: row.id,
    owner_org_id: row.owner_org_id,
    source_snapshot_id: row.source_snapshot_id,
    root_artifact_id: row.root_artifact_id,
    root_artifact_type: row.root_artifact_type,
    artifacts: decodeArtifacts(parsed),
    owner: { org_id: row.owner_org_id, name: row.owner_org_name },
    recipient: {
      user_id: row.recipient_user_id,
      email: row.recipient_email,
      name: row.recipient_name,
    },
    created_by: row.created_by,
    status: shareStatus(row),
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    imported_at: row.imported_at,
    imported_org_id: row.imported_org_id,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const DATABASE_DDL = `
CREATE TABLE IF NOT EXISTS selfhost_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS selfhost_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT,
  org_id TEXT NOT NULL,
  org_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_objects (
  org_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, sha256)
);

CREATE TABLE IF NOT EXISTS remote_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  parent_snapshot_id TEXT,
  schema_version TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS remote_snapshots_org_created_idx
  ON remote_snapshots (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_heads (
  org_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_shares (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT NOT NULL,
  owner_org_name TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  root_artifact_id TEXT NOT NULL,
  root_artifact_type TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT,
  accepted_at TEXT,
  imported_at TEXT,
  imported_org_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (recipient_user_id) REFERENCES selfhost_users(id)
);

CREATE INDEX IF NOT EXISTS remote_shares_owner_idx ON remote_shares (owner_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS remote_shares_recipient_idx
  ON remote_shares (recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_pack_links (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  object_sha256 TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('reusable_unlisted', 'private_single_claim')),
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS remote_pack_links_owner_idx
  ON remote_pack_links (owner_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributor_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  skill_hash TEXT NOT NULL,
  user_cohort TEXT NOT NULL,
  triggered INTEGER,
  invocation_type TEXT,
  execution_grade TEXT,
  query_bucket TEXT,
  miss_detected INTEGER,
  timestamp_bucket TEXT NOT NULL,
  client_version TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (org_id, source_key)
);

CREATE INDEX IF NOT EXISTS contributor_signals_org_skill_idx
  ON contributor_signals (org_id, skill_hash, received_at DESC);

CREATE TABLE IF NOT EXISTS hosted_devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_key TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (org_id, device_key)
);

CREATE TABLE IF NOT EXISTS hosted_manifests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (org_id, revision),
  FOREIGN KEY (device_id) REFERENCES hosted_devices(id)
);

CREATE INDEX IF NOT EXISTS hosted_manifests_org_observed_idx
  ON hosted_manifests (org_id, observed_at DESC);
`;

function initializeDatabase(config: SelfHostConfig): Database {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(config.dataDir, "objects"), { recursive: true, mode: 0o700 });
  const db = new Database(join(config.dataDir, "selftune-selfhost.db"), { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(DATABASE_DDL);
    db.run("INSERT OR IGNORE INTO selfhost_migrations (version, applied_at) VALUES (1, ?)", [
      new Date().toISOString(),
    ]);
    bootstrapAccounts(db, config);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function bootstrapAccounts(db: Database, config: SelfHostConfig): void {
  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.run("UPDATE selfhost_users SET active = 0, updated_at = ?", [now]);
    for (const account of config.accounts) {
      const existing = db
        .query<UserRow, [string]>(
          `SELECT id, email, name, org_id, org_name, role
           FROM selfhost_users WHERE lower(email) = lower(?)`,
        )
        .get(account.email);
      if (existing && account.orgId && existing.org_id !== account.orgId) {
        throw failure(
          "SelfHostAccountConflict",
          503,
          `Configured org_id for ${account.email} does not match its persisted organization.`,
        );
      }
      const id = existing?.id ?? randomUUID();
      const orgId = existing?.org_id ?? account.orgId ?? randomUUID();
      if (existing) {
        db.run(
          `UPDATE selfhost_users
           SET name = ?, org_name = ?, role = ?, token_hash = ?, active = 1, updated_at = ?
           WHERE id = ?`,
          [account.name, account.orgName, account.role, sha256(account.token), now, id],
        );
      } else {
        db.run(
          `INSERT INTO selfhost_users
             (id, email, name, org_id, org_name, role, token_hash, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            id,
            account.email,
            account.name,
            orgId,
            account.orgName,
            account.role,
            sha256(account.token),
            now,
            now,
          ],
        );
      }
    }
  });
  apply.immediate();
}

function validateArtifacts(artifacts: ReadonlyArray<RemoteArtifact>): void {
  if (artifacts.length > 10_000) {
    throw failure(
      "RemoteLibraryInvalidSnapshot",
      400,
      "A snapshot may contain at most 10,000 artifacts.",
    );
  }
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.artifact_id || artifact.artifact_id.length > 200) {
      throw failure(
        "RemoteLibraryInvalidSnapshot",
        400,
        "Artifact IDs must contain 1 to 200 characters.",
      );
    }
    if (!artifact.revision || artifact.revision.length > 200) {
      throw failure(
        "RemoteLibraryInvalidSnapshot",
        400,
        "Artifact revisions must contain 1 to 200 characters.",
      );
    }
    if (!isSha256(artifact.object_sha256)) {
      throw failure(
        "RemoteLibraryInvalidSnapshot",
        400,
        "Artifact object hashes must be lowercase SHA-256 values.",
      );
    }
    if (identities.has(artifact.artifact_id)) {
      throw failure(
        "RemoteLibraryInvalidSnapshot",
        400,
        `Duplicate artifact identity: ${artifact.artifact_id}`,
      );
    }
    identities.add(artifact.artifact_id);
  }
}

function objectPath(dataDir: string, orgId: string, objectSha256: string): string {
  return join(dataDir, "objects", orgId, objectSha256);
}

function fileMatchesHash(path: string, expectedSha256: string): boolean {
  try {
    return existsSync(path) && sha256(new Uint8Array(readFileSync(path))) === expectedSha256;
  } catch {
    return false;
  }
}

function replaceObjectAtomically(path: string, bytes: Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function objectRow(db: Database, orgId: string, objectSha256: string): ObjectRow | null {
  return db
    .query<ObjectRow, [string, string]>(
      `SELECT sha256, size_bytes, content_type
       FROM remote_objects WHERE org_id = ? AND sha256 = ?`,
    )
    .get(orgId, objectSha256);
}

function readStoredObject(
  db: Database,
  dataDir: string,
  orgId: string,
  objectSha256: string,
): StoredObject {
  const row = objectRow(db, orgId, objectSha256);
  const path = objectPath(dataDir, orgId, objectSha256);
  if (!row || !existsSync(path)) {
    throw failure("RemoteLibraryObjectMissing", 404, "Remote Library artifact not found", {
      object_sha256: objectSha256,
    });
  }
  const bytes = new Uint8Array(readFileSync(path));
  const actual = sha256(bytes);
  if (actual !== objectSha256) {
    throw failure(
      "RemoteLibraryHashMismatch",
      422,
      "Stored object SHA-256 does not match its immutable identity",
      { expected: objectSha256, actual },
    );
  }
  return {
    bytes,
    contentType: row.content_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  };
}

function getSnapshotRow(db: Database, orgId: string, snapshotId: string): SnapshotRow | null {
  return db
    .query<SnapshotRow, [string, string]>(
      `SELECT id, parent_snapshot_id, artifacts_json, created_at
       FROM remote_snapshots WHERE org_id = ? AND id = ?`,
    )
    .get(orgId, snapshotId);
}

function getHeadSync(db: Database, orgId: string): RemoteSnapshot | null {
  const row = db
    .query<SnapshotRow, [string]>(
      `SELECT s.id, s.parent_snapshot_id, s.artifacts_json, s.created_at
       FROM remote_heads h
       INNER JOIN remote_snapshots s ON s.id = h.snapshot_id AND s.org_id = h.org_id
       WHERE h.org_id = ?`,
    )
    .get(orgId);
  return row ? snapshotFromRow(row) : null;
}

function commitSnapshotSync(
  db: Database,
  dataDir: string,
  user: SelfHostUser,
  request: CreateSnapshotRequest,
): RemoteSnapshot {
  validateArtifacts(request.artifacts);
  if (request.expected_parent_id !== null && !isUuid(request.expected_parent_id)) {
    throw failure(
      "RemoteLibraryInvalidSnapshot",
      400,
      "expected_parent_id must be a UUID or null.",
    );
  }
  const commit = db.transaction(() => {
    const head = getHeadSync(db, user.orgId);
    const currentHeadId = head?.id ?? null;
    if (currentHeadId !== request.expected_parent_id) {
      throw failure(
        "RemoteLibraryHeadConflict",
        409,
        "Remote Library head changed; pull and reconcile before retrying",
        {
          expected_parent_id: request.expected_parent_id,
          current_head_id: currentHeadId,
        },
      );
    }
    const verifiedObjects = new Set<string>();
    for (const artifact of request.artifacts) {
      if (verifiedObjects.has(artifact.object_sha256)) continue;
      try {
        readStoredObject(db, dataDir, user.orgId, artifact.object_sha256);
        verifiedObjects.add(artifact.object_sha256);
      } catch (error) {
        if (!(error instanceof SelfHostFailure) || error.code !== "RemoteLibraryObjectMissing") {
          throw error;
        }
        throw failure(
          "RemoteLibraryObjectMissing",
          422,
          "Snapshot references an object that has not been uploaded",
          { object_sha256: artifact.object_sha256 },
        );
      }
    }
    const snapshot: RemoteSnapshot = {
      id: randomUUID(),
      parent_snapshot_id: currentHeadId,
      schema_version: "selftune.remote-library.snapshot.v1",
      artifacts: request.artifacts,
      created_at: new Date().toISOString(),
    };
    db.run(
      `INSERT INTO remote_snapshots
         (id, org_id, parent_snapshot_id, schema_version, artifacts_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        user.orgId,
        snapshot.parent_snapshot_id,
        snapshot.schema_version,
        JSON.stringify(snapshot.artifacts),
        user.id,
        snapshot.created_at,
      ],
    );
    db.run(
      `INSERT INTO remote_heads (org_id, snapshot_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`,
      [user.orgId, snapshot.id, snapshot.created_at],
    );
    return snapshot;
  });
  return commit.immediate();
}

const SHARE_SELECTION = `
  SELECT sh.id, sh.owner_org_id, sh.owner_org_name, sh.source_snapshot_id,
         sh.root_artifact_id, sh.root_artifact_type, sh.artifacts_json,
         sh.recipient_user_id, u.email AS recipient_email, u.name AS recipient_name,
         sh.created_by, sh.expires_at, sh.accepted_at, sh.imported_at,
         sh.imported_org_id, sh.revoked_at, sh.created_at, sh.updated_at
  FROM remote_shares sh
  INNER JOIN selfhost_users u ON u.id = sh.recipient_user_id
`;

function getShareRow(db: Database, shareId: string): ShareRow | null {
  return db.query<ShareRow, [string]>(`${SHARE_SELECTION} WHERE sh.id = ?`).get(shareId);
}

function activePackRow(db: Database, token: string): PackRow {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw failure("RemoteLibraryPackMissing", 404, "Skill Set Pack unavailable");
  }
  const row = db
    .query<PackRow, [string]>(
      `SELECT id, owner_org_id, source_snapshot_id, artifact_id, object_sha256,
              token_hash, mode, expires_at, claimed_at, revoked_at, created_at
       FROM remote_pack_links WHERE token_hash = ?`,
    )
    .get(sha256(token));
  if (
    !row ||
    row.revoked_at ||
    new Date(row.expires_at) <= new Date() ||
    (row.mode === "private_single_claim" && row.claimed_at)
  ) {
    throw failure("RemoteLibraryPackMissing", 404, "Skill Set Pack unavailable");
  }
  return row;
}

function decodePackObject(object: StoredObject) {
  try {
    return Effect.runSync(decodePortableSkillSetEnvelope(object.bytes));
  } catch {
    throw failure(
      "RemoteLibraryPackInvalid",
      409,
      "The Skill Set Pack failed integrity validation",
    );
  }
}

function assertShareVisible(row: ShareRow, user: SelfHostUser): void {
  if (row.owner_org_id !== user.orgId && row.recipient_user_id !== user.id) {
    throw failure(
      "RemoteLibraryShareForbidden",
      403,
      "This private share is not available to this account",
    );
  }
}

function assertShareRecipient(row: ShareRow, user: SelfHostUser): void {
  if (row.recipient_user_id !== user.id) {
    throw failure(
      "RemoteLibraryShareForbidden",
      403,
      "This private share is not available to this account",
    );
  }
}

function assertShareActive(row: ShareRow, now: Date): void {
  if (row.revoked_at) {
    throw failure("RemoteLibraryShareInactive", 410, "Private share is revoked", {
      reason: "revoked",
    });
  }
  if (row.expires_at && new Date(row.expires_at) <= now) {
    throw failure("RemoteLibraryShareInactive", 410, "Private share is expired", {
      reason: "expired",
    });
  }
}

function audit(
  db: Database,
  user: SelfHostUser,
  action: string,
  resourceId: string | null,
  metadata: Readonly<Record<string, unknown>> = {},
): void {
  db.run(
    `INSERT INTO remote_audit
       (org_id, user_id, action, resource_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.orgId, user.id, action, resourceId, JSON.stringify(metadata), new Date().toISOString()],
  );
}

function copyObjectForImport(
  db: Database,
  dataDir: string,
  ownerOrgId: string,
  recipient: SelfHostUser,
  artifact: RemoteArtifact,
): void {
  const source = readStoredObject(db, dataDir, ownerOrgId, artifact.object_sha256);
  const targetPath = objectPath(dataDir, recipient.orgId, artifact.object_sha256);
  if (!fileMatchesHash(targetPath, artifact.object_sha256)) {
    replaceObjectAtomically(targetPath, source.bytes);
  }
  db.run(
    `INSERT INTO remote_objects
       (org_id, sha256, size_bytes, content_type, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, sha256) DO UPDATE SET size_bytes = excluded.size_bytes`,
    [
      recipient.orgId,
      artifact.object_sha256,
      source.bytes.byteLength,
      source.contentType,
      recipient.id,
      new Date().toISOString(),
    ],
  );
  readStoredObject(db, dataDir, recipient.orgId, artifact.object_sha256);
}

function makeRepository(db: Database, config: SelfHostConfig): RepositoryService {
  const run = <A>(operation: string, body: () => A): Effect.Effect<A, SelfHostFailure> =>
    Effect.try({ try: body, catch: (cause) => storageFailure(operation, cause) });

  return {
    hostedState: (user) =>
      run("hosted_state", () => ({
        workspaceId: user.orgId,
        plan: "free" as const,
        status: "none" as const,
        currentPeriodEnd: null,
      })),

    publishManifest: (user, payload) =>
      run("publish_manifest", () => {
        if (payload.skills.length > 2_000) {
          throw failure("HostedManifestInvalid", 400, "Manifest exceeds 2,000 skills");
        }
        if (
          !payload.revision ||
          payload.revision.length > 200 ||
          !payload.device_name ||
          payload.device_name.length > 200 ||
          !payload.platform ||
          payload.platform.length > 100
        ) {
          throw failure("HostedManifestInvalid", 400, "Manifest metadata is invalid");
        }
        const deviceKey = sha256(`${user.id}:${payload.device_name}:${payload.platform}`);
        const existingDevice = db
          .query<{ readonly id: string }, [string, string]>(
            "SELECT id FROM hosted_devices WHERE org_id = ? AND device_key = ?",
          )
          .get(user.orgId, deviceKey);
        const deviceId = existingDevice?.id ?? randomUUID();
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO hosted_devices
             (id, org_id, user_id, device_key, name, platform, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, device_key) DO UPDATE SET
             name = excluded.name,
             platform = excluded.platform,
             last_seen_at = excluded.last_seen_at`,
          [deviceId, user.orgId, user.id, deviceKey, payload.device_name, payload.platform, now],
        );
        const inserted = db.run(
          `INSERT OR IGNORE INTO hosted_manifests
             (id, org_id, device_id, revision, skills_json, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            user.orgId,
            deviceId,
            payload.revision,
            JSON.stringify(payload.skills),
            now,
          ],
        );
        if (inserted.changes === 0) return { uploaded: 0, unchanged: payload.skills.length };
        audit(db, user, "manifest.published", payload.revision, {
          device_id: deviceId,
          skill_count: payload.skills.length,
        });
        return { uploaded: payload.skills.length, unchanged: 0 };
      }),

    receiveContribution: (user, payload) =>
      run("receive_contribution", () => {
        if (payload.relay_destination !== user.orgId) {
          const destination = db
            .query<{ readonly org_id: string }, [string]>(
              "SELECT org_id FROM selfhost_users WHERE org_id = ? AND active = 1 LIMIT 1",
            )
            .get(payload.relay_destination);
          if (!destination) {
            throw failure("ContributorDestinationMissing", 404, "Creator destination not found");
          }
        }
        if (!/^sk_sha256_[a-f0-9]{12}$/.test(payload.skill_hash)) {
          throw failure("ContributorSignalInvalid", 400, "Skill hash is invalid");
        }
        if (!/^uc_sha256_[a-f0-9]{12}$/.test(payload.user_cohort)) {
          throw failure("ContributorSignalInvalid", 400, "Contributor cohort is invalid");
        }
        db.run("DELETE FROM contributor_signals WHERE received_at < ?", [
          new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
        ]);
        const sourceKey = payload.source_key;
        const result = db.run(
          `INSERT OR IGNORE INTO contributor_signals
             (org_id, source_key, skill_hash, user_cohort, triggered, invocation_type,
              execution_grade, query_bucket, miss_detected, timestamp_bucket,
              client_version, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.relay_destination,
            sourceKey,
            payload.skill_hash,
            payload.user_cohort,
            payload.signals.triggered === undefined ? null : Number(payload.signals.triggered),
            payload.signals.invocation_type ?? null,
            payload.signals.execution_grade ?? null,
            payload.signals.query_bucket ?? null,
            payload.signals.miss_detected === undefined
              ? null
              : Number(payload.signals.miss_detected),
            payload.timestamp_bucket,
            payload.client_version,
            new Date().toISOString(),
          ],
        );
        audit(db, user, "contributor_signal.relayed", sourceKey, {
          destination_org_id: payload.relay_destination,
          skill_hash: payload.skill_hash,
        });
        return result.changes === 1 ? "accepted" : "duplicate";
      }),

    contributionAggregate: (user, skillHash) =>
      run("contribution_aggregate", () => {
        if (!/^sk_sha256_[a-f0-9]{12}$/.test(skillHash)) {
          throw failure("ContributorSignalInvalid", 400, "Skill hash is invalid");
        }
        const rows = db
          .query<
            {
              readonly user_cohort: string;
              readonly triggered: number | null;
              readonly miss_detected: number | null;
              readonly execution_grade: "A" | "B" | "C" | "F" | null;
            },
            [string, string]
          >(
            `SELECT user_cohort, triggered, miss_detected, execution_grade
             FROM contributor_signals
             WHERE org_id = ? AND skill_hash = ?
             ORDER BY received_at DESC LIMIT 5000`,
          )
          .all(user.orgId, skillHash);
        const grades = { A: 0, B: 0, C: 0, F: 0 };
        for (const row of rows) if (row.execution_grade) grades[row.execution_grade] += 1;
        return {
          observations: rows.length,
          cohorts: new Set(rows.map((row) => row.user_cohort)).size,
          triggered: rows.filter((row) => row.triggered === 1).length,
          missed: rows.filter((row) => row.miss_detected === 1).length,
          grades,
        };
      }),

    createPack: (user, request) =>
      run("create_pack", () => {
        if (!isUuid(request.snapshot_id)) {
          throw failure("RemoteLibraryInvalidPack", 400, "Snapshot ID must be a UUID");
        }
        const snapshotRow = getSnapshotRow(db, user.orgId, request.snapshot_id);
        const snapshot = snapshotRow ? snapshotFromRow(snapshotRow) : null;
        const artifact = snapshot?.artifacts.find(
          (candidate) => candidate.artifact_id === request.artifact_id,
        );
        if (!artifact || artifact.artifact_type !== "skill_set") {
          throw failure(
            "RemoteLibraryPackMissing",
            404,
            "The immutable Skill Set artifact was not found",
          );
        }
        const object = readStoredObject(db, config.dataDir, user.orgId, artifact.object_sha256);
        const decoded = decodePackObject(object);
        if (
          decoded.envelope.components.length === 0 ||
          decoded.envelope.components.some(
            (component) => component.terms.licenseExpression.trim().length === 0,
          )
        ) {
          throw failure(
            "RemoteLibraryPackLicenseRequired",
            409,
            "Every Skill Set component needs distributable license terms",
          );
        }
        const now = new Date();
        const expiresAt = request.expires_at
          ? new Date(request.expires_at)
          : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
          throw failure("RemoteLibraryInvalidPack", 400, "Pack expiry must be in the future");
        }
        const id = randomUUID();
        const token = derivedPackToken(id, config.packLinkSecret ?? config.adminToken);
        db.run(
          `INSERT INTO remote_pack_links
             (id, owner_org_id, source_snapshot_id, artifact_id, object_sha256,
              token_hash, mode, expires_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            user.orgId,
            request.snapshot_id,
            request.artifact_id,
            artifact.object_sha256,
            sha256(token),
            request.mode,
            expiresAt.toISOString(),
            user.id,
            now.toISOString(),
          ],
        );
        audit(db, user, "remote_library.pack.created", id, {
          artifact_id: request.artifact_id,
          mode: request.mode,
        });
        return {
          id,
          token,
          mode: request.mode,
          expiresAt: expiresAt.toISOString(),
          objectSha256: artifact.object_sha256,
          skillSetRevisionSha256: decoded.envelope.skillSetRevisionSha256,
        };
      }),

    listPacks: (user) =>
      run("list_packs", () => {
        const rows = db
          .query<PackRow, [string]>(
            `SELECT id, owner_org_id, source_snapshot_id, artifact_id, object_sha256,
                    token_hash, mode, expires_at, claimed_at, revoked_at, created_at
             FROM remote_pack_links WHERE owner_org_id = ? ORDER BY created_at DESC`,
          )
          .all(user.orgId);
        const now = new Date();
        const packs = rows.map((row): SelfHostPackManagementItem => {
          const object = readStoredObject(db, config.dataDir, row.owner_org_id, row.object_sha256);
          const decoded = decodePackObject(object);
          const token = derivedPackToken(row.id, config.packLinkSecret ?? config.adminToken);
          const status = row.revoked_at
            ? "revoked"
            : new Date(row.expires_at) <= now
              ? "expired"
              : row.claimed_at
                ? "claimed"
                : "active";
          return {
            packId: row.id,
            artifactId: row.artifact_id,
            name: decoded.envelope.sourceManifest.name,
            description: decoded.envelope.sourceManifest.description,
            mode: row.mode,
            status,
            packUrl:
              status === "active" && sha256(token) === row.token_hash
                ? `${config.publicUrl.replace(/\/$/, "")}/p/${token}`
                : null,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
            claimedAt: row.claimed_at,
            revokedAt: row.revoked_at,
            skillSetRevisionSha256: decoded.envelope.skillSetRevisionSha256,
            objectSha256: row.object_sha256,
            componentCount: decoded.envelope.components.length,
          };
        });
        return { packs };
      }),

    previewPack: (token) =>
      run("preview_pack", () => {
        const row = activePackRow(db, token);
        const object = readStoredObject(db, config.dataDir, row.owner_org_id, row.object_sha256);
        const decoded = decodePackObject(object);
        return {
          protocol: "selftune.skill-set-pack.v1",
          packId: row.id,
          artifactId: row.artifact_id,
          name: decoded.envelope.sourceManifest.name,
          description: decoded.envelope.sourceManifest.description,
          skillSetRevisionSha256: decoded.envelope.skillSetRevisionSha256,
          objectSha256: row.object_sha256,
          mode: row.mode,
          expiresAt: row.expires_at,
          requiresSignIn: false,
          components: decoded.envelope.components.map((component) => ({
            logicalSkillId: component.logicalSkillId,
            licenseExpression: component.terms.licenseExpression,
          })),
        } satisfies SelfHostPackPreview;
      }),

    getPackContent: (token) =>
      run("get_pack_content", () => {
        const row = activePackRow(db, token);
        if (row.mode === "private_single_claim") {
          const claimedAt = new Date().toISOString();
          const result = db.run(
            `UPDATE remote_pack_links SET claimed_at = ?
             WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL`,
            [claimedAt, row.id],
          );
          if (result.changes !== 1) {
            throw failure("RemoteLibraryPackClaimed", 409, "Skill Set Pack already claimed");
          }
        }
        const object = readStoredObject(db, config.dataDir, row.owner_org_id, row.object_sha256);
        decodePackObject(object);
        return {
          bytes: object.bytes,
          contentType: object.contentType,
          objectSha256: row.object_sha256,
        };
      }),

    revokePack: (user, packId) =>
      run("revoke_pack", () => {
        if (!isUuid(packId)) {
          throw failure("RemoteLibraryInvalidPack", 400, "Pack ID must be a UUID");
        }
        const revokedAt = new Date().toISOString();
        const result = db.run(
          `UPDATE remote_pack_links SET revoked_at = ?
           WHERE id = ? AND owner_org_id = ? AND revoked_at IS NULL`,
          [revokedAt, packId, user.orgId],
        );
        if (result.changes !== 1) {
          throw failure("RemoteLibraryPackMissing", 404, "Skill Set Pack unavailable");
        }
        audit(db, user, "remote_library.pack.revoked", packId);
        return { id: packId, revokedAt };
      }),

    authenticate: (token) =>
      run("authenticate", () => {
        const row = db
          .query<UserRow, [string]>(
            `SELECT id, email, name, org_id, org_name, role
             FROM selfhost_users WHERE token_hash = ? AND active = 1`,
          )
          .get(sha256(token));
        return row ? userFromRow(row) : null;
      }),

    putObject: (user, objectSha256, bytes, contentType) =>
      run("put_object", () => {
        if (!isSha256(objectSha256)) {
          throw failure(
            "RemoteLibraryInvalidObject",
            400,
            "Object SHA-256 must be 64 lowercase hex characters",
          );
        }
        if (bytes.byteLength > config.maxObjectBytes) {
          throw failure(
            "RemoteLibraryObjectTooLarge",
            413,
            "Remote Library object exceeds the server limit",
          );
        }
        const actual = sha256(bytes);
        if (actual !== objectSha256) {
          throw failure(
            "RemoteLibraryHashMismatch",
            422,
            "Object SHA-256 did not match the requested immutable identity",
            { expected: objectSha256, actual },
          );
        }
        const existing = objectRow(db, user.orgId, objectSha256);
        const path = objectPath(config.dataDir, user.orgId, objectSha256);
        if (!fileMatchesHash(path, objectSha256)) {
          replaceObjectAtomically(path, bytes);
        }
        const normalizedContentType =
          contentType.trim().slice(0, 200) || "application/octet-stream";
        db.run(
          `INSERT INTO remote_objects
             (org_id, sha256, size_bytes, content_type, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, sha256) DO UPDATE SET size_bytes = excluded.size_bytes`,
          [
            user.orgId,
            objectSha256,
            bytes.byteLength,
            normalizedContentType,
            user.id,
            new Date().toISOString(),
          ],
        );
        return {
          sha256: objectSha256,
          sizeBytes: bytes.byteLength,
          contentType: existing?.content_type ?? normalizedContentType,
          created: existing === null,
        };
      }),

    hasObject: (user, objectSha256) =>
      run("head_object", () => readStoredObject(db, config.dataDir, user.orgId, objectSha256)),

    getObject: (user, objectSha256) =>
      run("get_object", () => readStoredObject(db, config.dataDir, user.orgId, objectSha256)),

    getHead: (user) => run("get_head", () => getHeadSync(db, user.orgId)),

    getSnapshot: (user, snapshotId) =>
      run("get_snapshot", () => {
        if (!isUuid(snapshotId)) {
          throw failure("RemoteLibraryInvalidSnapshot", 400, "Snapshot ID must be a UUID");
        }
        const row = getSnapshotRow(db, user.orgId, snapshotId);
        if (!row) {
          throw failure("RemoteLibrarySnapshotMissing", 404, "Remote Library artifact not found");
        }
        return snapshotFromRow(row);
      }),

    commitSnapshot: (user, request) =>
      run("commit_snapshot", () => commitSnapshotSync(db, config.dataDir, user, request)),

    diagnostics: (user) =>
      run("diagnostics", () => {
        const objectCount =
          db
            .query<CountRow, [string]>(
              "SELECT COUNT(*) AS count FROM remote_objects WHERE org_id = ?",
            )
            .get(user.orgId)?.count ?? 0;
        const snapshotCount =
          db
            .query<CountRow, [string]>(
              "SELECT COUNT(*) AS count FROM remote_snapshots WHERE org_id = ?",
            )
            .get(user.orgId)?.count ?? 0;
        const totalBytes =
          db
            .query<BytesRow, [string]>(
              "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM remote_objects WHERE org_id = ?",
            )
            .get(user.orgId)?.total ?? 0;
        const snapshotRows = db
          .query<{ readonly artifacts_json: string }, [string]>(
            "SELECT artifacts_json FROM remote_snapshots WHERE org_id = ?",
          )
          .all(user.orgId);
        const referenced = new Set<string>();
        for (const row of snapshotRows) {
          const parsed: unknown = JSON.parse(row.artifacts_json);
          for (const artifact of decodeArtifacts(parsed)) referenced.add(artifact.object_sha256);
        }
        const objectRows = db
          .query<{ readonly sha256: string }, [string]>(
            "SELECT sha256 FROM remote_objects WHERE org_id = ?",
          )
          .all(user.orgId);
        const stored = new Set(objectRows.map((row) => row.sha256));
        const missingObjects = [...referenced]
          .filter(
            (objectSha256) =>
              !stored.has(objectSha256) ||
              !fileMatchesHash(objectPath(config.dataDir, user.orgId, objectSha256), objectSha256),
          )
          .toSorted();
        const orphanedObjects = [...stored]
          .filter((objectSha256) => !referenced.has(objectSha256))
          .toSorted();
        return {
          status: missingObjects.length === 0 ? "ok" : "degraded",
          object_count: objectCount,
          snapshot_count: snapshotCount,
          referenced_object_count: referenced.size,
          total_bytes: totalBytes,
          missing_objects: missingObjects,
          orphaned_objects: orphanedObjects,
        } satisfies RemoteDiagnostics;
      }),

    createShare: (user, request) =>
      run("create_share", () => {
        if (!isUuid(request.snapshot_id)) {
          throw failure("RemoteLibraryInvalidShare", 400, "Snapshot ID must be a UUID");
        }
        const snapshotRow = getSnapshotRow(db, user.orgId, request.snapshot_id);
        if (!snapshotRow) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        const snapshot = snapshotFromRow(snapshotRow);
        const root = snapshot.artifacts.find(
          (artifact) => artifact.artifact_id === request.artifact_id,
        );
        if (!root) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        if (root.artifact_type !== "skill_revision" && root.artifact_type !== "skill_set") {
          throw failure(
            "RemoteLibraryShareUnsupportedArtifact",
            422,
            "Only immutable skill revisions and Skill Sets can be shared",
            { artifact_type: root.artifact_type },
          );
        }
        const recipient = db
          .query<UserRow, [string]>(
            `SELECT id, email, name, org_id, org_name, role FROM selfhost_users
             WHERE lower(email) = lower(?) AND active = 1`,
          )
          .get(request.recipient_email);
        if (!recipient) {
          throw failure(
            "RemoteLibraryShareRecipientNotFound",
            404,
            "Recipient must have a SelfTune account",
          );
        }
        const artifacts: RemoteArtifact[] = [root];
        if (root.artifact_type === "skill_set") {
          const object = readStoredObject(db, config.dataDir, user.orgId, root.object_sha256);
          let manifest: typeof SharedSetManifest.Type;
          try {
            const parsed: unknown = JSON.parse(new TextDecoder().decode(object.bytes));
            manifest = decodeSetManifest(parsed);
          } catch (error) {
            throw failure(
              "RemoteLibraryShareDependencyMissing",
              422,
              "Skill Set manifest is invalid",
              { cause: error instanceof Error ? error.message : String(error) },
            );
          }
          for (const dependency of manifest.skills) {
            const artifact = snapshot.artifacts.find(
              (candidate) =>
                (candidate.artifact_type === "skill_revision" ||
                  candidate.artifact_type === "draft_revision") &&
                candidate.revision === dependency.content_hash,
            );
            if (!artifact) {
              throw failure(
                "RemoteLibraryShareDependencyMissing",
                422,
                "Skill Set cannot be shared because a pinned revision is missing",
                { revision: dependency.content_hash },
              );
            }
            if (!artifacts.some((candidate) => candidate.artifact_id === artifact.artifact_id)) {
              artifacts.push(artifact);
            }
          }
        }
        let expiresAt: string | null = null;
        if (request.expires_at) {
          const parsed = new Date(request.expires_at);
          if (Number.isNaN(parsed.getTime())) {
            throw failure("RemoteLibraryInvalidShare", 400, "expires_at must be an ISO date-time");
          }
          expiresAt = parsed.toISOString();
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO remote_shares
             (id, owner_org_id, owner_org_name, source_snapshot_id, root_artifact_id,
              root_artifact_type, artifacts_json, recipient_user_id, created_by,
              expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            user.orgId,
            user.orgName,
            snapshot.id,
            root.artifact_id,
            root.artifact_type,
            JSON.stringify(artifacts),
            recipient.id,
            user.id,
            expiresAt,
            now,
            now,
          ],
        );
        audit(db, user, "remote_library.share.created", id, {
          recipient_user_id: recipient.id,
          artifact_count: artifacts.length,
        });
        const row = getShareRow(db, id);
        if (!row) throw new TypeError("Share disappeared after creation");
        return shareFromRow(row);
      }),

    listShares: (user) =>
      run("list_shares", () => {
        const rows = db
          .query<ShareRow, [string, string]>(
            `${SHARE_SELECTION}
             WHERE sh.owner_org_id = ? OR sh.recipient_user_id = ?
             ORDER BY sh.created_at DESC`,
          )
          .all(user.orgId, user.id);
        return {
          inbox: rows.filter((row) => row.recipient_user_id === user.id).map(shareFromRow),
          outbox: rows.filter((row) => row.owner_org_id === user.orgId).map(shareFromRow),
        };
      }),

    getShare: (user, shareId) =>
      run("get_share", () => {
        if (!isUuid(shareId)) {
          throw failure("RemoteLibraryInvalidShare", 400, "Share ID must be a UUID");
        }
        const row = getShareRow(db, shareId);
        if (!row) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        assertShareVisible(row, user);
        return shareFromRow(row);
      }),

    acceptShare: (user, shareId) =>
      run("accept_share", () => {
        const row = getShareRow(db, shareId);
        if (!row) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        assertShareRecipient(row, user);
        const now = new Date();
        assertShareActive(row, now);
        if (!row.accepted_at) {
          db.run("UPDATE remote_shares SET accepted_at = ?, updated_at = ? WHERE id = ?", [
            now.toISOString(),
            now.toISOString(),
            row.id,
          ]);
          audit(db, user, "remote_library.share.accepted", row.id);
        }
        const updated = getShareRow(db, row.id);
        if (!updated) throw new TypeError("Share disappeared after acceptance");
        return shareFromRow(updated);
      }),

    revokeShare: (user, shareId) =>
      run("revoke_share", () => {
        const row = getShareRow(db, shareId);
        if (!row) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        if (row.owner_org_id !== user.orgId) {
          throw failure(
            "RemoteLibraryShareForbidden",
            403,
            "This private share is not available to this account",
          );
        }
        if (!row.revoked_at) {
          const now = new Date().toISOString();
          db.run("UPDATE remote_shares SET revoked_at = ?, updated_at = ? WHERE id = ?", [
            now,
            now,
            row.id,
          ]);
          audit(db, user, "remote_library.share.revoked", row.id);
        }
        const updated = getShareRow(db, row.id);
        if (!updated) throw new TypeError("Share disappeared after revocation");
        return shareFromRow(updated);
      }),

    importShare: (user, shareId) =>
      run("import_share", () => {
        const row = getShareRow(db, shareId);
        if (!row) {
          throw failure(
            "RemoteLibraryShareNotFound",
            404,
            "Private share or source artifact not found",
          );
        }
        assertShareRecipient(row, user);
        const now = new Date();
        assertShareActive(row, now);
        if (!row.accepted_at) {
          throw failure("RemoteLibraryShareInactive", 410, "Private share is not_accepted", {
            reason: "not_accepted",
          });
        }
        if (row.imported_org_id && row.imported_org_id !== user.orgId) {
          throw failure(
            "RemoteLibraryShareConflict",
            409,
            "A different immutable revision already uses this artifact identity",
            { artifact_id: row.root_artifact_id },
          );
        }
        const share = shareFromRow(row);
        const head = getHeadSync(db, user.orgId);
        const merged = new Map(
          (head?.artifacts ?? []).map((artifact) => [artifact.artifact_id, artifact]),
        );
        for (const artifact of share.artifacts) {
          const existing = merged.get(artifact.artifact_id);
          if (existing && existing.object_sha256 !== artifact.object_sha256) {
            throw failure(
              "RemoteLibraryShareConflict",
              409,
              "A different immutable revision already uses this artifact identity",
              { artifact_id: artifact.artifact_id },
            );
          }
          merged.set(artifact.artifact_id, artifact);
        }
        for (const artifact of share.artifacts) {
          copyObjectForImport(db, config.dataDir, row.owner_org_id, user, artifact);
        }
        const artifacts = [...merged.values()].toSorted((left, right) =>
          left.artifact_id.localeCompare(right.artifact_id),
        );
        const changed = share.artifacts.some(
          (artifact) =>
            !head?.artifacts.some(
              (current) =>
                current.artifact_id === artifact.artifact_id &&
                current.object_sha256 === artifact.object_sha256,
            ),
        );
        const snapshot = changed
          ? commitSnapshotSync(db, config.dataDir, user, {
              schema_version: "selftune.remote-library.snapshot.v1",
              expected_parent_id: head?.id ?? null,
              artifacts,
            })
          : head;
        if (!row.imported_at) {
          const importedAt = now.toISOString();
          db.run(
            `UPDATE remote_shares
             SET imported_at = ?, imported_org_id = ?, updated_at = ? WHERE id = ?`,
            [importedAt, user.orgId, importedAt, row.id],
          );
          audit(db, user, "remote_library.share.imported", row.id, {
            owner_org_id: row.owner_org_id,
            artifact_count: share.artifacts.length,
          });
        }
        const updated = getShareRow(db, row.id);
        if (!updated) throw new TypeError("Share disappeared after import");
        return { share: shareFromRow(updated), snapshot };
      }),
  };
}

export function SelfHostRepositoryLive(config: SelfHostConfig) {
  return Layer.effect(
    SelfHostRepository,
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const db = initializeDatabase(config);
          return { db, service: makeRepository(db, config) };
        },
        catch: (cause) => storageFailure("initialize", cause),
      }),
      ({ db }) => Effect.sync(() => db.close()),
    ).pipe(Effect.map(({ service }) => service)),
  );
}

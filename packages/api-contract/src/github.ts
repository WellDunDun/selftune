import { Schema } from "effect";

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
const NullableString = Schema.NullOr(Schema.String);

export class CloudGithubInstallation extends Schema.Class<CloudGithubInstallation>(
  "CloudGithubInstallation",
)({
  id: Schema.String,
  installationId: PositiveInt,
  accountLogin: Schema.String,
  accountType: Schema.Literals(["User", "Organization"]),
  suspended: Schema.Boolean,
  updatedAt: Schema.String,
}) {}

export class CloudGithubConnection extends Schema.Class<CloudGithubConnection>(
  "CloudGithubConnection",
)({
  id: Schema.String,
  entryName: Schema.String,
  installationId: PositiveInt,
  repository: Schema.String,
  branch: Schema.String,
  skillPath: Schema.String,
  autoPublish: Schema.Boolean,
  writeBackEnabled: Schema.Boolean,
  lastSyncStatus: NullableString,
  lastSyncAt: NullableString,
}) {}

export class CloudGithubStatus extends Schema.Class<CloudGithubStatus>("CloudGithubStatus")({
  installations: Schema.Array(CloudGithubInstallation),
  connections: Schema.Array(CloudGithubConnection),
  canManageConnections: Schema.Boolean,
}) {}

export class CloudGithubInstallSession extends Schema.Class<CloudGithubInstallSession>(
  "CloudGithubInstallSession",
)({
  url: Schema.NonEmptyString,
}) {}

export class CloudGithubConnectionSync extends Schema.Class<CloudGithubConnectionSync>(
  "CloudGithubConnectionSync",
)({
  connectionId: Schema.String,
  status: Schema.String,
  version: Schema.String,
  sourceRef: Schema.String,
  publishedAt: Schema.String,
  message: Schema.String,
}) {}

export const CloudGithubApiPaths = {
  status: "/api/v1/cloud/github",
  startInstall: "/api/v1/cloud/github/install/start",
  syncConnection: "/api/v1/cloud/github/connections/:connectionId/sync",
} as const;

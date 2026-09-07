import { flow } from "effect";
import * as Schema from "effect/Schema";
import {
  HostedSkillSetInstallationReceiptRequest,
  HostedSkillSetReceiptFailureCode,
} from "@selftune/control-plane";
import { InstallerAgent, InstallerScope } from "./installer/types.js";

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Strings = Schema.Array(Schema.String);
const Targets = Schema.Array(InstallerAgent);

const StoredPreview = Schema.Struct({
  confirmationRequestId: Schema.String,
  assignmentId: Schema.String,
  assignmentRequestId: Schema.String,
  releaseId: Schema.String,
  skillSetRevisionSha256: Schema.String,
  envelopeSha256: Schema.String,
  scope: InstallerScope,
  projectRoot: Schema.NullOr(Schema.String),
  targetAgents: Targets,
  previewToken: Schema.String,
  expectedReceiptIds: Strings,
  expectedChangedReceiptIds: Strings,
  changedSkillCount: Count,
  blockedSkillCount: Count,
  previewedAt: Count,
});
export type StoredPreview = typeof StoredPreview.Type;

const StoredPendingInstall = Schema.Struct({
  assignmentId: Schema.String,
  assignmentRequestId: Schema.String,
  installRequestId: Schema.String,
  releaseId: Schema.String,
  skillSetRevisionSha256: Schema.String,
  envelopeSha256: Schema.String,
  receiptId: Schema.String,
  expectedReceiptIds: Strings,
  expectedChangedReceiptIds: Strings,
  scope: InstallerScope,
  targetAgents: Targets,
  changedSkillCount: Count,
  installedAt: Count,
  lifecycleSequence: Count,
});
export type StoredPendingInstall = typeof StoredPendingInstall.Type;

const StoredBinding = Schema.Struct({
  assignmentId: Schema.String,
  assignmentRequestId: Schema.String,
  installRequestId: Schema.String,
  releaseId: Schema.String,
  skillSetRevisionSha256: Schema.String,
  envelopeSha256: Schema.String,
  receiptId: Schema.String,
  robustReceiptIds: Strings,
  scope: InstallerScope,
  targetAgents: Targets,
  changedSkillCount: Count,
  lifecycleSequence: Count,
  failureCode: Schema.NullOr(HostedSkillSetReceiptFailureCode),
  state: Schema.Literals(["current", "rolled_back", "failed"]),
  installedAt: Count,
  rolledBackAt: Schema.NullOr(Count),
});
export type StoredBinding = typeof StoredBinding.Type;

const StoredPendingRollback = Schema.Struct({
  assignmentId: Schema.String,
  binding: StoredBinding,
  rolledBackAt: Count,
  lifecycleSequence: Count,
});
export type StoredPendingRollback = typeof StoredPendingRollback.Type;

const StoredOutboxItem = Schema.Struct({
  request: HostedSkillSetInstallationReceiptRequest,
  attempts: Count,
  lastAttemptAt: Schema.NullOr(Count),
  deliveredAt: Schema.NullOr(Count),
  terminalFailureAt: Schema.NullOr(Count),
  hostedReceiptId: Schema.NullOr(Schema.String),
});
export type StoredOutboxItem = typeof StoredOutboxItem.Type;

const State = Schema.Struct({
  version: Schema.Literal(1),
  previews: Schema.Record(Schema.String, StoredPreview),
  pendingInstalls: Schema.optionalKey(Schema.Record(Schema.String, StoredPendingInstall)),
  pendingRollbacks: Schema.optionalKey(Schema.Record(Schema.String, StoredPendingRollback)),
  bindings: Schema.Record(Schema.String, StoredBinding),
  outbox: Schema.Record(Schema.String, StoredOutboxItem),
});

export const decodeTeamAssignmentState = flow(
  Schema.decodeUnknownSync(Schema.fromJsonString(State)),
  (state) => ({
    ...state,
    pendingInstalls: state.pendingInstalls ?? {},
    pendingRollbacks: state.pendingRollbacks ?? {},
  }),
);
export type TeamAssignmentState = ReturnType<typeof decodeTeamAssignmentState>;

export function emptyTeamAssignmentState(): TeamAssignmentState {
  return {
    version: 1,
    previews: {},
    pendingInstalls: {},
    pendingRollbacks: {},
    bindings: {},
    outbox: {},
  };
}

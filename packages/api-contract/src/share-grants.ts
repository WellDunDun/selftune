import { Schema } from "effect";

import { Sha256Schema, UtcTimestampSchema } from "./distribution";
import {
  NormalizedRecipientEmailSchema,
  ShareInvitationClaimTokenSchema,
} from "./share-invitations";

export const ShareGrantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ShareGrantId"),
);
export type ShareGrantId = Schema.Schema.Type<typeof ShareGrantIdSchema>;

export const ShareGrantModeSchema = Schema.Literals(["reusable_unlisted", "private_single_claim"]);
export type ShareGrantMode = Schema.Schema.Type<typeof ShareGrantModeSchema>;

export const ShareGrantDeliverySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("copy_link") }),
  Schema.Struct({
    _tag: Schema.Literal("email"),
    recipientEmail: NormalizedRecipientEmailSchema,
  }),
]);
export type ShareGrantDelivery = Schema.Schema.Type<typeof ShareGrantDeliverySchema>;

const ShareGrantIssueBase = {
  skillId: Schema.NonEmptyString,
  sourceRevisionHash: Sha256Schema,
  expiresAt: UtcTimestampSchema,
};

export const ShareGrantIssueRequest = Schema.Union([
  Schema.Struct({
    ...ShareGrantIssueBase,
    mode: ShareGrantModeSchema,
    delivery: Schema.Struct({ _tag: Schema.Literal("copy_link") }),
  }),
  Schema.Struct({
    ...ShareGrantIssueBase,
    mode: Schema.Literal("private_single_claim"),
    delivery: Schema.Struct({
      _tag: Schema.Literal("email"),
      recipientEmail: NormalizedRecipientEmailSchema,
    }),
  }),
]);
export type ShareGrantIssueRequest = Schema.Schema.Type<typeof ShareGrantIssueRequest>;

export const ShareGrantSenderStatusSchema = Schema.Literals([
  "active",
  "delivered",
  "claimed",
  "imported",
  "expired",
  "revoked",
]);

export class ShareGrantIssueResult extends Schema.Class<ShareGrantIssueResult>(
  "ShareGrantIssueResult",
)({
  shareId: ShareGrantIdSchema,
  mode: ShareGrantModeSchema,
  claimToken: ShareInvitationClaimTokenSchema,
  status: ShareGrantSenderStatusSchema,
  expiresAt: UtcTimestampSchema,
}) {}

export class ShareGrantSenderView extends Schema.Class<ShareGrantSenderView>(
  "ShareGrantSenderView",
)({
  shareId: ShareGrantIdSchema,
  skillId: Schema.NonEmptyString,
  sourceRevisionHash: Sha256Schema,
  mode: ShareGrantModeSchema,
  delivery: Schema.Literals(["copy_link", "email"]),
  status: ShareGrantSenderStatusSchema,
  expiresAt: UtcTimestampSchema,
}) {}

export class ShareGrantSenderInventory extends Schema.Class<ShareGrantSenderInventory>(
  "ShareGrantSenderInventory",
)({
  shares: Schema.Array(ShareGrantSenderView),
}) {}

export class ShareGrantRevokeResult extends Schema.Class<ShareGrantRevokeResult>(
  "ShareGrantRevokeResult",
)({
  shareId: ShareGrantIdSchema,
  status: Schema.Literal("revoked"),
}) {}

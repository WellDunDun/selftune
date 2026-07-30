import { Schema } from "effect";

export const TeamApiPaths = {
  status: "/api/v1/cloud/team",
  invite: "/api/v1/cloud/team/invitations",
  member: "/api/v1/cloud/team/members/:userId",
  invitation: "/api/v1/cloud/team/invitations/:invitationId",
} as const;
export const TeamRole = Schema.Literals(["viewer", "member", "admin", "owner"]);
export type TeamRole = Schema.Schema.Type<typeof TeamRole>;
export const TeamInviteRole = Schema.Literals(["viewer", "member", "admin"]);
export const TeamMember = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  role: TeamRole,
  joinedAt: Schema.String,
});
export type TeamMember = Schema.Schema.Type<typeof TeamMember>;
export const TeamInvitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: TeamRole,
  invitedBy: Schema.String,
  invitedAt: Schema.String,
});
export type TeamInvitation = Schema.Schema.Type<typeof TeamInvitation>;
export const TeamStatus = Schema.Struct({
  currentUserId: Schema.String,
  currentRole: TeamRole,
  readOnly: Schema.Boolean,
  seatUsage: Schema.Int,
  seatLimit: Schema.NullOr(Schema.Int),
  billingPath: Schema.String,
  members: Schema.mutable(Schema.Array(TeamMember)),
  invitations: Schema.mutable(Schema.Array(TeamInvitation)),
});
export type TeamStatus = Schema.Schema.Type<typeof TeamStatus>;
export class TeamInviteInput extends Schema.Class<TeamInviteInput>("TeamInviteInput")({
  email: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(320),
      Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    ),
  ),
  role: TeamInviteRole,
}) {}
export class TeamRoleChangeInput extends Schema.Class<TeamRoleChangeInput>("TeamRoleChangeInput")({
  role: TeamInviteRole,
}) {}

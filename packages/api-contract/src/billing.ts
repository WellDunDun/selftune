import { Schema } from "effect";

export const BillingPlanIdSchema = Schema.Literals(["free", "pro", "team", "enterprise"]);
export type BillingPlanId = Schema.Schema.Type<typeof BillingPlanIdSchema>;

export const StripeSubscriptionStatusSchema = Schema.Literals([
  "none",
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);
export type StripeSubscriptionStatus = Schema.Schema.Type<typeof StripeSubscriptionStatusSchema>;

const PositiveIntSchema = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));

export class BillingPlanSeats extends Schema.Class<BillingPlanSeats>("BillingPlanSeats")({
  minimum: PositiveIntSchema,
  label: Schema.NullOr(Schema.String),
}) {}

export class BillingPlan extends Schema.Class<BillingPlan>("BillingPlan")({
  id: BillingPlanIdSchema,
  name: Schema.String,
  price: Schema.NullOr(Schema.String),
  period: Schema.NullOr(Schema.String),
  description: Schema.String,
  features: Schema.Array(Schema.String),
  highlighted: Schema.Boolean,
  seats: Schema.optional(Schema.NullOr(BillingPlanSeats)),
}) {}

export class BillingStatus extends Schema.Class<BillingStatus>("BillingStatus")({
  plan: BillingPlanIdSchema,
  subscriptionStatus: StripeSubscriptionStatusSchema,
  currentPeriodEnd: Schema.NullOr(Schema.String),
  trialEnd: Schema.NullOr(Schema.String),
  seatCount: PositiveIntSchema,
  hasStripeCustomer: Schema.Boolean,
  canManageBilling: Schema.Boolean,
  availablePlans: Schema.Array(BillingPlan),
}) {}

export class BillingCheckoutInput extends Schema.Class<BillingCheckoutInput>(
  "BillingCheckoutInput",
)({
  plan: Schema.Literals(["pro", "team"]),
  seats: Schema.optional(PositiveIntSchema),
}) {}

export class BillingSession extends Schema.Class<BillingSession>("BillingSession")({
  url: Schema.NonEmptyString,
}) {}

export class BillingCheckoutFinalizeInput extends Schema.Class<BillingCheckoutFinalizeInput>(
  "BillingCheckoutFinalizeInput",
)({
  sessionId: Schema.NonEmptyString,
}) {}

export class BillingCheckoutFinalizeResult extends Schema.Class<BillingCheckoutFinalizeResult>(
  "BillingCheckoutFinalizeResult",
)({
  finalized: Schema.Boolean,
  billing: Schema.NullOr(BillingStatus),
  sessionStatus: Schema.NullOr(Schema.String),
  paymentStatus: Schema.NullOr(Schema.String),
}) {}

export const BillingApiPaths = {
  status: "/api/v1/cloud/billing/status",
  checkout: "/api/v1/cloud/billing/checkout",
  portal: "/api/v1/cloud/billing/portal",
  finalizeCheckout: "/api/v1/cloud/billing/checkout/finalize",
} as const;

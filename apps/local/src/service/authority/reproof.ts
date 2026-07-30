import * as Effect from "effect/Effect";

import type { AuthorityEvidenceReference } from "./evidence.js";

export const reproveAuthority = Effect.fn("SelfTuneService.authority.reprove")(function* <
  TEvidence,
  EInspect,
  EChanged,
  R,
>(
  inspect: Effect.Effect<TEvidence, EInspect, R>,
  expected: TEvidence,
  reference: AuthorityEvidenceReference<TEvidence>,
  changed: () => EChanged,
) {
  const actual = yield* inspect;
  if (
    !reference.acceptsControl(expected) ||
    !reference.acceptsControl(actual) ||
    !reference.sameAuthority(expected, actual)
  ) {
    return yield* Effect.fail(changed());
  }
  return actual;
});

export type AuthorityEvidenceTag =
  | "Absent"
  | "LegacyCompatible"
  | "Owned"
  | "OwnedIncomplete"
  | "Refused";

export type AuthorityMatch<TReason> =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: TReason };

export type AuthorityEvidence<TContext, TOwned, TLegacy, TRefused> =
  | (TContext & { readonly _tag: "Absent" })
  | (TContext & TOwned & { readonly _tag: "Owned" })
  | (TContext & TOwned & { readonly _tag: "OwnedIncomplete" })
  | (TContext & TLegacy & { readonly _tag: "LegacyCompatible" })
  | (TContext & TRefused & { readonly _tag: "Refused" });

export interface AuthorityEvidenceReference<TEvidence> {
  readonly acceptsControl: (evidence: TEvidence) => boolean;
  readonly sameAuthority: (expected: TEvidence, actual: TEvidence) => boolean;
}

export function authorityMatch(): AuthorityMatch<never> {
  return { matches: true };
}

export function authorityMismatch<TReason>(reason: TReason): AuthorityMatch<TReason> {
  return { matches: false, reason };
}

export function acceptsAuthorityControl(evidence: {
  readonly _tag: AuthorityEvidenceTag;
}): boolean {
  return evidence._tag === "Owned" || evidence._tag === "LegacyCompatible";
}

export function acceptsAuthorityInstall(evidence: {
  readonly _tag: AuthorityEvidenceTag;
}): boolean {
  return evidence._tag !== "Refused";
}

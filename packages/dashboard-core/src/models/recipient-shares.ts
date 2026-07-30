export type RecipientSupportedAgent = "codex" | "claude_code" | "opencode" | "openclaw" | "pi";

export interface RecipientActionBindingsModel {
  readonly invitationId: string;
  readonly shareId: string;
  readonly distributionId: string;
  readonly sealedObjectId: string;
  readonly packagedSha256: string;
}

export interface RecipientShareDisclosureModel {
  readonly publisher: { readonly name: string };
  readonly rightsHolder: {
    readonly kind: "organization" | "user" | "external";
    readonly name: string;
  };
  readonly artifact: {
    readonly subjectId: string;
    readonly sourceRevisionHash: string;
    readonly packagedSha256: string;
  };
  readonly license: {
    readonly expression: string;
    readonly kind: "spdx" | "license_ref" | "proprietary";
    readonly licenseEvidenceSha256: string;
    readonly bundledTerms: null | { readonly path: string; readonly sha256: string };
  };
  readonly provenance: {
    readonly kind:
      | "github_verified"
      | "selftune_authored"
      | "imported_upstream"
      | "self_attested_upload";
    readonly sourceRepository: string | null;
    readonly sourceRef: string | null;
    readonly sourceTreeHash: string | null;
  };
  readonly contributorSignals:
    | {
        readonly _tag: "signals_unavailable";
        readonly signalDisclosureSha256: string;
        readonly signalRecipientOrganizationId: null;
        readonly allowedFields: readonly [];
        readonly defaultState: "off";
      }
    | {
        readonly _tag: "capable_default_off";
        readonly signalDisclosureSha256: string;
        readonly signalRecipientOrganizationId: string;
        readonly allowedFields: readonly ("trigger" | "grade" | "miss_category")[];
        readonly defaultState: "off";
      };
  readonly lifecycleReporting: {
    readonly download: {
      readonly disclosureSha256: string;
      readonly defaultConsent: "not_granted";
    };
    readonly useOnce: {
      readonly disclosureSha256: string;
      readonly defaultConsent: "not_granted";
    };
  };
  readonly accountlessEligibility: "public_allowed" | "account_required";
  readonly acceptance: {
    readonly required: boolean;
    readonly disclosureSha256: string;
  };
}

export interface RecipientShareModel {
  readonly mode: "public_preview" | "claimed_inbox";
  readonly status: "available" | "claimed";
  readonly expiresAt: string;
  readonly claimedAt: string | null;
  readonly disclosure: RecipientShareDisclosureModel;
  /** Authoritative sealed-manifest projection. Actions fail closed when absent. */
  readonly packageInspection: null | {
    readonly manifestSha256: string;
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[];
    readonly securityDecision: {
      readonly decision: "authorized_sealed";
      readonly policyVersion: string;
      readonly transform: {
        readonly name: string;
        readonly version: string;
      };
      readonly packagedSha256: string;
    };
  };
  /** Server-derived exact object binding. Actions fail closed until it is present. */
  readonly actionBindings: RecipientActionBindingsModel | null;
  readonly licenseAcceptance: {
    readonly required: boolean;
    readonly satisfied: boolean;
    readonly acceptedAt: string | null;
  };
  readonly importStatus: "not_imported" | "imported";
}

export interface RecipientShareQueryState {
  readonly data: RecipientShareModel | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly errorKind:
    | "expired"
    | "revoked_or_unavailable"
    | "replay"
    | "forbidden"
    | "unknown"
    | null;
  refresh(): void | Promise<void>;
}

export interface RecipientDownloadConsentInput {
  readonly acceptTerms: true;
  readonly downloadLifecycleReporting: boolean;
  readonly contributorSignals: boolean;
}

export interface RecipientInstallConsentInput {
  readonly acceptTerms: true;
  readonly contributorSignals: boolean;
}

export interface RecipientUseOnceInput {
  readonly acceptTerms: true;
  readonly useOnceLifecycleReporting: boolean;
  readonly contributorSignals: boolean;
  readonly supportedAgent: RecipientSupportedAgent;
}

export type RecipientActionFailureKind =
  | "expired"
  | "replay"
  | "forbidden"
  | "conflict"
  | "unknown";

/** A host-normalized action failure that can be rendered without inspecting transport errors. */
export class RecipientActionFailure extends Error {
  readonly kind: RecipientActionFailureKind;

  constructor(kind: RecipientActionFailureKind, message: string) {
    super(message);
    this.name = "RecipientActionFailure";
    this.kind = kind;
  }
}

export interface RecipientUseOnceHandoffModel {
  readonly handoffToken: string;
  readonly supportedAgent: RecipientSupportedAgent;
  readonly expiresAt: string;
  readonly helper: {
    /** Official release selector; it is not itself a pinned artifact descriptor. */
    readonly releaseSelectorHref: string;
    readonly instructionsHref: string;
    readonly invocation: string;
  };
}

export interface RecipientInstallLaunchModel {
  readonly deepLink: `selftune://${string}`;
  readonly desktopDownloadHref: string;
  readonly resumableExplanation: string;
}

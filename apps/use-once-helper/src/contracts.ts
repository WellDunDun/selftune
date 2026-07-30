export const SUPPORTED_AGENTS = ["codex", "claude_code", "opencode", "openclaw", "pi"] as const;
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

/** Fixed path templates for the eventual HTTPS authority adapter; never caller-provided URLs. */
export const USE_ONCE_AUTHORITY_PATHS = {
  preview: "/api/v1/recipient-actions/use-once/preview",
  consume: "/api/v1/recipient-actions/use-once/consume",
  content: (issueId: string) => `/api/v1/recipient-actions/use-once/${issueId}/content`,
} as const;

export type ContributorSignalField = "trigger" | "grade" | "miss_category";

export type ContributorSignals =
  | {
      readonly _tag: "signals_unavailable";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: null;
      readonly allowedFields: readonly [];
      readonly capability: "not_capable";
      readonly defaultState: "off";
      readonly contributorConsent: "not_applicable";
      readonly enabled: false;
    }
  | {
      readonly _tag: "capable_default_off";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: string;
      readonly allowedFields: readonly ContributorSignalField[];
      readonly capability: "capable";
      readonly defaultState: "off";
      readonly contributorConsent: "not_granted";
      readonly enabled: false;
    }
  | {
      readonly _tag: "capable_consented";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: string;
      readonly allowedFields: readonly ContributorSignalField[];
      readonly capability: "capable";
      readonly defaultState: "off";
      readonly contributorConsent: "granted";
      readonly enabled: true;
    };

export type HelperContributorSignals =
  | {
      readonly _tag: "unavailable";
      readonly signalDisclosureSha256: string;
      readonly allowedFields: readonly [];
      readonly defaultState: "off";
      readonly trustedTelemetry: "not_authorized";
    }
  | {
      readonly _tag: "portable_unverified";
      readonly signalDisclosureSha256: string;
      readonly allowedFields: readonly ContributorSignalField[];
      readonly defaultState: "off";
      readonly trustedTelemetry: "not_authorized";
    };

export interface UseOnceBinding {
  readonly issueId: string;
  readonly invitationId: string;
  readonly shareId: string;
  readonly distributionId: string;
  readonly sealedObjectId: string;
  readonly packagedSha256: string;
}

export interface UseOncePreview extends UseOnceBinding {
  readonly status: "preview";
  readonly supportedAgent: SupportedAgent;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly publisher: { readonly name: string };
  readonly rightsHolder: {
    readonly kind: "organization" | "user" | "external";
    readonly name: string;
  };
  readonly package: {
    readonly displayName: string;
    readonly version: string;
    readonly format: "selftune-portable-package-v2";
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
  readonly terms: {
    readonly disclosureSha256: string;
    readonly summary: string;
    readonly issueAcceptance: "accepted_at_issue";
  };
  readonly contributorSignals: ContributorSignals;
  readonly lifecycleReporting: {
    readonly _tag: "used_once_status";
    readonly lifecycleDisclosureSha256: string;
    readonly consent: "not_granted" | "granted";
    readonly senderVisibleUsedOnceStatus: "disabled" | "enabled";
  };
  readonly helperContributorSignals: HelperContributorSignals;
  readonly persistence: "ephemeral_use_once";
  readonly persistentInstall: "not_authorized";
  readonly trustedTelemetry: "not_authorized";
  readonly contentRetrieval: "repeatable_exact_object_before_consume";
  readonly previewMutation: "none";
  readonly usedOnceReporting: "not_emitted";
  readonly consumeRequired: true;
  readonly authorityLimits: {
    readonly localPath: "not_provided";
    readonly command: "not_provided";
    readonly url: "not_provided";
    readonly bytes: "not_provided";
    readonly credential: "not_provided";
    readonly installAuthority: "not_authorized";
  };
}

export interface UseOnceConfirmation {
  readonly termsDisclosureSha256: string;
  readonly termsAcceptance: "accepted";
  readonly executionConsent: "granted";
}

export interface VerifiedUseOnceDisclosure {
  readonly preview: UseOncePreview;
  readonly bundledTerms: null | {
    readonly path: string;
    readonly sha256: string;
    readonly content: string;
  };
}

export interface UseOnceConsumption extends UseOnceBinding {
  readonly requestId: string;
  readonly supportedAgent: SupportedAgent;
  readonly termsDisclosureSha256: string;
  readonly termsAcceptance: "accepted";
  readonly executionConsent: "granted";
  readonly status: "consumed";
  readonly consumedAt: string;
  readonly expiresAt: string;
  readonly persistence: "ephemeral_use_once";
  readonly persistentInstall: "not_authorized";
  readonly trustedTelemetry: "not_authorized";
  readonly lifecycleReporting: UseOncePreview["lifecycleReporting"];
  readonly contributorSignals: ContributorSignals;
  readonly recipientAccess: "authenticated" | "accountless";
  readonly accountlessPolicyResult: "authenticated_account" | "public_allowed";
}

export interface SealedObjectDelivery extends UseOnceBinding {
  readonly contentType: "application/vnd.selftune.portable-package+json";
  readonly contentLength: number;
  readonly contentSha256: string;
  readonly bytes: Uint8Array;
}

/**
 * Required Cloud seam. Implementations must use fixed HTTPS endpoints and opaque
 * authorities; this port deliberately has no URL, header, or credential input.
 */
export interface UseOnceAuthorityClient {
  preview(input: {
    readonly handoffToken: string;
    readonly supportedAgent: SupportedAgent;
    readonly signal?: AbortSignal;
  }): Promise<UseOncePreview>;
  consume(input: {
    readonly handoffToken: string;
    readonly preview: UseOncePreview;
    readonly confirmation: UseOnceConfirmation;
    readonly signal?: AbortSignal;
  }): Promise<UseOnceConsumption>;
  retrievePreviewObject(input: {
    readonly handoffToken: string;
    readonly preview: UseOncePreview;
    readonly signal?: AbortSignal;
  }): Promise<SealedObjectDelivery>;
}

export interface DisclosurePort {
  show(disclosure: VerifiedUseOnceDisclosure): Promise<void>;
  confirm(disclosure: VerifiedUseOnceDisclosure): Promise<UseOnceConfirmation | null>;
}

export interface StagedUseOnceWorkspace {
  readonly rootDirectory: string;
  readonly skillDirectory: string;
  cleanup(): Promise<void>;
}

export interface UseOnceWorkspacePort {
  recoverStale(): Promise<void>;
  stage(input: {
    readonly files: readonly { readonly path: string; readonly content: Uint8Array }[];
  }): Promise<StagedUseOnceWorkspace>;
}

export interface AgentInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface AgentExecutionPort {
  execute(invocation: AgentInvocation, signal: AbortSignal): Promise<number>;
}

import type {
  ContributorSignalFieldSchema,
  ContributorSignalsSchema,
  HelperContributorSignalsSchema,
  UseOncePreviewSchema,
  UseOnceConsumptionSchema,
  SealedObjectDeliverySchema,
} from "./authority-contract";

export const SUPPORTED_AGENTS = ["codex", "claude_code", "opencode", "openclaw", "pi"] as const;
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

/** Fixed path templates for the eventual HTTPS authority adapter; never caller-provided URLs. */
export const USE_ONCE_AUTHORITY_PATHS = {
  preview: "/api/v1/recipient-actions/use-once/preview",
  consume: "/api/v1/recipient-actions/use-once/consume",
  content: (issueId: string) => `/api/v1/recipient-actions/use-once/${issueId}/content`,
} as const;

export type ContributorSignalField = typeof ContributorSignalFieldSchema.Type;
export type ContributorSignals = typeof ContributorSignalsSchema.Type;
export type HelperContributorSignals = typeof HelperContributorSignalsSchema.Type;

export interface UseOnceBinding {
  readonly issueId: string;
  readonly invitationId: string;
  readonly shareId: string;
  readonly distributionId: string;
  readonly sealedObjectId: string;
  readonly packagedSha256: string;
}

export type UseOncePreview = typeof UseOncePreviewSchema.Type;

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

export type UseOnceConsumption = typeof UseOnceConsumptionSchema.Type;
export type SealedObjectDelivery = typeof SealedObjectDeliverySchema.Type;

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

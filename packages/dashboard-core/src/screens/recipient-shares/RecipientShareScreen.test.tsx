// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardHostProvider, type DashboardHostAdapter } from "../../host";
import { RecipientActionFailure, type RecipientShareModel } from "../../models";
import { RecipientShareScreen } from "./RecipientShareScreen";

const binding = {
  invitationId: "11111111-1111-4111-8111-111111111111",
  shareId: "22222222-2222-4222-8222-222222222222",
  distributionId: "33333333-3333-4333-8333-333333333333",
  sealedObjectId: "44444444-4444-4444-8444-444444444444",
  packagedSha256: "b".repeat(64),
};

function share(overrides: Partial<RecipientShareModel> = {}): RecipientShareModel {
  return {
    mode: "public_preview",
    status: "available",
    expiresAt: "2026-07-22T00:00:00.000Z",
    claimedAt: null,
    actionBindings: binding,
    packageInspection: {
      manifestSha256: "9".repeat(64),
      files: [
        { path: "SKILL.md", sha256: "7".repeat(64), byteLength: 512 },
        { path: "LICENSE", sha256: "8".repeat(64), byteLength: 1_024 },
      ],
      securityDecision: {
        decision: "authorized_sealed",
        policyVersion: "sealed-package-policy-v1",
        transform: { name: "selftune-portable-package", version: "1" },
        packagedSha256: binding.packagedSha256,
      },
    },
    disclosure: {
      publisher: { name: "Acme Skills" },
      rightsHolder: { kind: "external", name: "Example Author" },
      artifact: {
        subjectId: "review-helper",
        sourceRevisionHash: "a".repeat(64),
        packagedSha256: binding.packagedSha256,
      },
      license: {
        expression: "MIT",
        kind: "spdx",
        licenseEvidenceSha256: "c".repeat(64),
        bundledTerms: { path: "LICENSE", sha256: "8".repeat(64) },
      },
      provenance: {
        kind: "github_verified",
        sourceRepository: "https://github.com/acme/review-helper",
        sourceRef: "refs/tags/v1.0.0",
        sourceTreeHash: "d".repeat(40),
      },
      contributorSignals: {
        _tag: "capable_default_off",
        signalDisclosureSha256: "e".repeat(64),
        signalRecipientOrganizationId: "55555555-5555-4555-8555-555555555555",
        allowedFields: ["trigger", "grade"],
        defaultState: "off",
      },
      lifecycleReporting: {
        download: {
          disclosureSha256: "f".repeat(64),
          defaultConsent: "not_granted",
        },
        useOnce: {
          disclosureSha256: "0".repeat(64),
          defaultConsent: "not_granted",
        },
      },
      accountlessEligibility: "public_allowed",
      acceptance: { required: false, disclosureSha256: "1".repeat(64) },
    },
    licenseAcceptance: { required: false, satisfied: true, acceptedAt: null },
    importStatus: "not_imported",
    ...overrides,
  };
}

function adapter(
  options: {
    data?: RecipientShareModel | null;
    error?: string | null;
    errorKind?: "expired" | "revoked_or_unavailable" | "replay" | "forbidden" | "unknown" | null;
    actionFailures?: Partial<
      Record<"claim" | "accept" | "download" | "useOnce" | "install", RecipientActionFailure>
    >;
  } = {},
) {
  const claim = vi.fn(async () => {
    if (options.actionFailures?.claim) throw options.actionFailures.claim;
  });
  const accept = vi.fn(async () => {
    if (options.actionFailures?.accept) throw options.actionFailures.accept;
  });
  const download = vi.fn(async () => {
    if (options.actionFailures?.download) throw options.actionFailures.download;
  });
  const useOnce = vi.fn(async (input) => {
    if (options.actionFailures?.useOnce) throw options.actionFailures.useOnce;
    return {
      handoffToken: "H".repeat(43),
      supportedAgent: input.supportedAgent,
      expiresAt: "2026-07-21T01:00:00.000Z",
      helper: {
        releaseSelectorHref: "https://github.com/selftune-dev/selftune/releases/latest",
        instructionsHref: "https://docs.selftune.dev/run/use-once",
        invocation: `selftune-use-once --token ${"H".repeat(43)} --agent ${input.supportedAgent}`,
      },
    };
  });
  const install = vi.fn(async () => {
    if (options.actionFailures?.install) throw options.actionFailures.install;
    return {
      deepLink: `selftune://install/${"B".repeat(43)}` as const,
      desktopDownloadHref: "https://github.com/selftune-dev/selftune/releases/latest",
      resumableExplanation: "Install Desktop, then reopen this share to resume.",
    };
  });
  const openDesktopDeepLink = vi.fn();
  const value: DashboardHostAdapter = {
    host: "cloud",
    plan: "oss",
    features: {},
    authentication: { useSession: () => ({ status: "anonymous" }) },
    queries: {
      fetchOverview: async () => {
        throw new Error("unused");
      },
      fetchSkills: async () => ({ items: [] }),
      fetchAnalytics: async () => {
        throw new Error("unused");
      },
    },
    navigation: { upgrade: "/upgrade", openUpgrade() {} },
    mutations: {},
    permissions: { can: () => false },
    library: { access: "unavailable", reason: "unused" },
    projects: { access: "unavailable", reason: "unused" },
    decisions: { access: "unavailable", reason: "unused" },
    recipientShares: {
      access: "available",
      useShare: () => ({
        data: options.data === undefined ? share() : options.data,
        isLoading: false,
        error: options.error ?? null,
        errorKind: options.errorKind ?? null,
        refresh() {},
      }),
      useActions: () => ({
        signIn: { access: "available", href: "/auth/sign-in" },
        claim: { access: "available", execute: claim },
        acceptLicense: { access: "available", execute: accept },
        importToLibrary: {
          access: "unavailable",
          reason: "Claim before import.",
        },
        download: { access: "available", execute: download },
        useOnce: { access: "available", execute: useOnce },
        installWithSelfTune: { access: "available", execute: install },
      }),
      openDesktopDeepLink,
    },
  };
  return {
    value,
    claim,
    accept,
    download,
    useOnce,
    install,
    openDesktopDeepLink,
  };
}

function renderShare(value: DashboardHostAdapter) {
  return render(
    <DashboardHostProvider adapter={value}>
      <RecipientShareScreen />
    </DashboardHostProvider>,
  );
}

afterEach(cleanup);

describe("recipient share journey", () => {
  it("renders a public preview with exact rights, provenance, files, hashes, and separate disclosures", () => {
    renderShare(adapter().value);
    expect(screen.getByRole("heading", { name: "review-helper" })).toBeTruthy();
    expect(screen.getByText("Acme Skills")).toBeTruthy();
    expect(screen.getByText(/Example Author/)).toBeTruthy();
    expect(screen.getByText(/MIT/)).toBeTruthy();
    expect(screen.getByText("GitHub verified")).toBeTruthy();
    expect(screen.getByText("Security decision: authorized sealed")).toBeTruthy();
    expect(screen.getByText("SKILL.md")).toBeTruthy();
    expect(screen.getByText("Contributor signals: off by default")).toBeTruthy();
    expect(screen.getByText("Download status: off by default")).toBeTruthy();
    expect(screen.getByText(/Viewing this page does not install/)).toBeTruthy();
  });

  it("keeps download side effects behind a click and sends default-off consent", async () => {
    const harness = adapter();
    renderShare(harness.value);
    expect(harness.download).not.toHaveBeenCalled();
    expect(harness.useOnce).not.toHaveBeenCalled();
    expect(harness.install).not.toHaveBeenCalled();
    expect(harness.openDesktopDeepLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Accept the disclosed terms"));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(harness.download).toHaveBeenCalledWith({
        acceptTerms: true,
        downloadLifecycleReporting: false,
        contributorSignals: false,
      }),
    );

    expect(screen.queryByRole("button", { name: "Use once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install with SelfTune" })).toBeNull();
  });

  it("requires separate consent for Download lifecycle reporting", async () => {
    const harness = adapter();
    renderShare(harness.value);
    fireEvent.click(screen.getByLabelText("Accept the disclosed terms"));
    fireEvent.click(screen.getByLabelText("Allow download status reporting"));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(harness.download).toHaveBeenCalledTimes(1));
    expect(harness.download).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadLifecycleReporting: true }),
    );
  });

  it("explains account-required terms and disables accountless actions", () => {
    const required = share({
      disclosure: {
        ...share().disclosure,
        accountlessEligibility: "account_required",
        acceptance: { required: true, disclosureSha256: "1".repeat(64) },
      },
    });
    renderShare(adapter({ data: required }).value);
    expect(screen.getByText(/These terms require an account/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Download" }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use once" })).toBeNull();
  });

  it("fails closed when the server omits inspection evidence", () => {
    renderShare(adapter({ data: share({ packageInspection: null }) }).value);
    expect(
      screen.getByText(/authoritative file manifest and security decision are unavailable/),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Accept the disclosed terms"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Download" }).disabled).toBe(true);
  });

  it("fails closed when the sealed decision does not match the disclosed package", () => {
    const mismatched = share();
    renderShare(
      adapter({
        data: {
          ...mismatched,
          packageInspection: mismatched.packageInspection
            ? {
                ...mismatched.packageInspection,
                securityDecision: {
                  ...mismatched.packageInspection.securityDecision,
                  packagedSha256: "6".repeat(64),
                },
              }
            : null,
        },
      }).value,
    );
    fireEvent.click(screen.getByLabelText("Accept the disclosed terms"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Download" }).disabled).toBe(true);
  });

  it("renders typed expired failures accessibly", () => {
    renderShare(
      adapter({
        data: null,
        error: "Expired at 2026-07-22.",
        errorKind: "expired",
      }).value,
    );
    expect(screen.getByRole("alert").textContent).toContain("This share link expired");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    {
      action: "claim" as const,
      kind: "expired" as const,
      button: "Claim to workspace",
    },
    {
      action: "accept" as const,
      kind: "forbidden" as const,
      button: "Accept license for this share",
    },
    {
      action: "download" as const,
      kind: "conflict" as const,
      button: "Download",
    },
  ])(
    "renders typed $kind failures from the $action interaction",
    async ({ action, kind, button }) => {
      const failure = new RecipientActionFailure(kind, `${action} backend detail`);
      const claimedWithPendingAcceptance = share({
        mode: action === "accept" ? "claimed_inbox" : "public_preview",
        status: action === "accept" ? "claimed" : "available",
        licenseAcceptance:
          action === "accept"
            ? { required: true, satisfied: false, acceptedAt: null }
            : share().licenseAcceptance,
      });
      renderShare(
        adapter({
          data: claimedWithPendingAcceptance,
          actionFailures: { [action]: failure },
        }).value,
      );
      if (action === "download") {
        fireEvent.click(screen.getByLabelText("Accept the disclosed terms"));
      }
      fireEvent.click(screen.getByRole("button", { name: button }));
      const alert = await screen.findByRole("alert");
      expect(alert.getAttribute("data-failure-kind")).toBe(kind);
      expect(alert.textContent).toContain(`${action} backend detail`);
    },
  );
});

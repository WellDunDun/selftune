"use client";

import { useState } from "react";
import { DownloadIcon, ShieldCheckIcon } from "lucide-react";

import {
  useRecipientSharesModule,
  type DashboardRecipientShareActions,
  type DashboardRecipientSharesContribution,
} from "../../host";
import {
  RecipientActionFailure,
  type RecipientActionFailureKind,
  type RecipientDownloadConsentInput,
  type RecipientShareDisclosureModel,
  type RecipientShareModel,
} from "../../models";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  Skeleton,
} from "@selftune/ui/primitives";

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function provenanceLabel(kind: RecipientShareDisclosureModel["provenance"]["kind"]): string {
  switch (kind) {
    case "github_verified":
      return "GitHub verified";
    case "selftune_authored":
      return "SelfTune authored";
    case "imported_upstream":
      return "Imported upstream";
    case "self_attested_upload":
      return "Self-attested upload";
  }
}

function ErrorState({
  kind,
  message,
  retry,
}: {
  kind: "expired" | "revoked_or_unavailable" | "replay" | "forbidden" | "unknown" | null;
  message: string;
  retry(): void | Promise<void>;
}) {
  const title =
    kind === "expired"
      ? "This share link expired"
      : kind === "replay"
        ? "This one-time action was already used"
        : kind === "forbidden"
          ? "You do not have access to this share"
          : kind === "revoked_or_unavailable"
            ? "This share is no longer available"
            : "The share could not be loaded";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-xl" role="alert">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        {kind === "unknown" ? (
          <CardFooter>
            <Button onClick={() => void retry()}>Try again</Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}

function Inspection({ inspection }: { inspection: RecipientShareModel["packageInspection"] }) {
  if (!inspection) {
    return (
      <div
        className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground"
        role="status"
      >
        The authoritative file manifest and security decision are unavailable. Recipient actions
        remain disabled.
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
        <p className="font-medium">Security decision: authorized sealed</p>
        <p className="mt-1 text-muted-foreground">
          Policy {inspection.securityDecision.policyVersion} · transform{" "}
          {inspection.securityDecision.transform.name}{" "}
          {inspection.securityDecision.transform.version}
        </p>
        <p className="mt-1 text-muted-foreground">
          This proves the exact authorized bytes and manifest. It does not certify script safety or
          independently verify legal rights.
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">Sealed file manifest</p>
        <p>
          {inspection.files.length} files · SHA-256{" "}
          <span className="font-mono text-xs">{shortHash(inspection.manifestSha256)}</span>
        </p>
      </div>
      <ul className="max-h-44 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
        {inspection.files.map((file) => (
          <li
            className="grid gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0"
            key={file.path}
          >
            <span className="break-all font-mono text-xs">{file.path}</span>
            <span className="text-xs text-muted-foreground">
              {file.byteLength.toLocaleString()} bytes · {shortHash(file.sha256)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Disclosure({ data }: { data: RecipientShareModel }) {
  const disclosure = data.disclosure;
  const signals = disclosure.contributorSignals;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-primary" /> Rights and origin
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Publisher</p>
            <p>{disclosure.publisher.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Rights holder</p>
            <p>
              {disclosure.rightsHolder.name} · {disclosure.rightsHolder.kind}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">License</p>
            <p>
              {disclosure.license.expression} · {disclosure.license.kind}
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              Evidence SHA-256 {disclosure.license.licenseEvidenceSha256}
            </p>
          </div>
          {disclosure.license.bundledTerms ? (
            <div>
              <p className="text-muted-foreground">Bundled terms</p>
              <p className="break-all font-mono text-xs">{disclosure.license.bundledTerms.path}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                SHA-256 {disclosure.license.bundledTerms.sha256}
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground">No separate bundled terms file.</p>
          )}
          <div>
            <p className="text-muted-foreground">Provenance strength</p>
            <p>{provenanceLabel(disclosure.provenance.kind)}</p>
          </div>
          {disclosure.provenance.sourceRepository ? (
            <div>
              <p className="text-muted-foreground">Source</p>
              <p className="break-all">
                {disclosure.provenance.sourceRepository}
                {disclosure.provenance.sourceRef ? ` · ${disclosure.provenance.sourceRef}` : ""}
              </p>
            </div>
          ) : null}
          {disclosure.provenance.sourceTreeHash ? (
            <div>
              <p className="text-muted-foreground">Source tree</p>
              <p className="break-all font-mono text-xs">{disclosure.provenance.sourceTreeHash}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Immutable package</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Skill revision</p>
            <p>{disclosure.artifact.subjectId}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Revision hash</p>
            <p className="font-mono text-xs" title={disclosure.artifact.sourceRevisionHash}>
              {shortHash(disclosure.artifact.sourceRevisionHash)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Package hash</p>
            <p className="font-mono text-xs" title={disclosure.artifact.packagedSha256}>
              {shortHash(disclosure.artifact.packagedSha256)}
            </p>
          </div>
          <Inspection inspection={data.packageInspection} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Data sharing</CardTitle>
          <CardDescription>
            Contributor signals and sender-visible lifecycle status are separate choices.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Contributor signals: off by default</p>
            <p className="mt-1 text-muted-foreground">
              {signals._tag === "signals_unavailable"
                ? "This package cannot send contributor signals."
                : `If you opt in, ${signals.signalRecipientOrganizationId} may receive only: ${signals.allowedFields.join(", ")}.`}
            </p>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
              Disclosure {signals.signalDisclosureSha256}
            </p>
          </div>
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Download status: off by default</p>
            <p className="mt-1 text-muted-foreground">
              You can allow only a downloaded status for the Download action. No path, machine,
              prompt, or skill contents are reported.
            </p>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
              Disclosure {disclosure.lifecycleReporting.download.disclosureSha256}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ConsentControls({
  capable,
  terms,
  downloadLifecycle,
  signals,
  setTerms,
  setDownloadLifecycle,
  setSignals,
}: {
  capable: boolean;
  terms: boolean;
  downloadLifecycle: boolean;
  signals: boolean;
  setTerms(value: boolean): void;
  setDownloadLifecycle(value: boolean): void;
  setSignals(value: boolean): void;
}) {
  return (
    <fieldset className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <legend className="px-1 text-sm font-medium">Your choices</legend>
      <Label className="flex items-start gap-3 font-normal">
        <Checkbox
          aria-label="Accept the disclosed terms"
          checked={terms}
          onCheckedChange={(value) => setTerms(value === true)}
        />
        <span>
          <span className="font-medium">I accept the disclosed terms</span>
          <span className="block text-sm text-muted-foreground">Required for Download.</span>
        </span>
      </Label>
      <Label className="flex items-start gap-3 font-normal">
        <Checkbox
          aria-label="Allow download status reporting"
          checked={downloadLifecycle}
          onCheckedChange={(value) => setDownloadLifecycle(value === true)}
        />
        <span>
          <span className="font-medium">Share Download status with the sender</span>
          <span className="block text-sm text-muted-foreground">
            Optional and off by default. Applies only to Download.
          </span>
        </span>
      </Label>
      <Label className="flex items-start gap-3 font-normal">
        <Checkbox
          aria-label="Allow contributor signals"
          disabled={!capable}
          checked={signals}
          onCheckedChange={(value) => setSignals(value === true)}
        />
        <span>
          <span className="font-medium">Allow the exact contributor signal fields above</span>
          <span className="block text-sm text-muted-foreground">
            Optional, separate, and off by default.
            {capable ? "" : " This share is not capable of sending them."}
          </span>
        </span>
      </Label>
    </fieldset>
  );
}

function reason(action: { access: string; reason?: string }): string | undefined {
  return action.access === "unavailable"
    ? (action.reason ?? "This action is unavailable.")
    : undefined;
}

function hasConsistentRecipientAuthority(data: RecipientShareModel): boolean {
  const binding = data.actionBindings;
  const inspection = data.packageInspection;
  return (
    binding !== null &&
    inspection !== null &&
    binding.packagedSha256 === data.disclosure.artifact.packagedSha256 &&
    inspection.securityDecision.packagedSha256 === binding.packagedSha256
  );
}

function ActionFailureNotice({
  action,
  failure,
}: {
  action: string;
  failure: RecipientActionFailure;
}) {
  const title =
    failure.kind === "expired"
      ? `${action} authorization expired`
      : failure.kind === "replay"
        ? `${action} was already used`
        : failure.kind === "forbidden"
          ? `${action} is not allowed`
          : failure.kind === "conflict"
            ? `${action} conflicts with the current share state`
            : `${action} failed`;
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
      data-failure-kind={failure.kind}
      role="alert"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1">{failure.message}</p>
    </div>
  );
}

function Actions({
  actions,
  data,
}: {
  actions: DashboardRecipientShareActions;
  data: RecipientShareModel;
}) {
  const [terms, setTerms] = useState(false);
  const [downloadLifecycle, setDownloadLifecycle] = useState(false);
  const [signals, setSignals] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failureNotice, setFailureNotice] = useState<null | {
    action: string;
    failure: RecipientActionFailure;
  }>(null);
  const signalCapable = data.disclosure.contributorSignals._tag === "capable_default_off";
  const accountlessBlocked =
    data.disclosure.accountlessEligibility === "account_required" && data.mode === "public_preview";
  const authorityReady = hasConsistentRecipientAuthority(data);
  const actionBlocked = !terms || accountlessBlocked || !authorityReady;
  const downloadConsent = (): RecipientDownloadConsentInput => ({
    acceptTerms: true,
    downloadLifecycleReporting: downloadLifecycle,
    contributorSignals: signals,
  });

  async function run(name: string, task: () => Promise<void>) {
    setPending(name);
    setFailureNotice(null);
    try {
      await task();
    } catch (cause) {
      const failure =
        cause instanceof RecipientActionFailure
          ? cause
          : new RecipientActionFailure(
              "unknown" satisfies RecipientActionFailureKind,
              cause instanceof Error ? cause.message : String(cause),
            );
      setFailureNotice({ action: name, failure });
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose what happens next</CardTitle>
        <CardDescription>
          Claim, import, and portable download are distinct actions.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {accountlessBlocked ? (
          <div
            className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground"
            role="status"
          >
            These terms require an account. Sign in and claim the share before downloading or
            importing it.
          </div>
        ) : null}
        {!authorityReady ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
            Recipient actions are unavailable until the server provides the exact sealed-object
            binding and inspection decision.
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button render={<a href={actions.signIn.href} />}>
            {data.mode === "claimed_inbox" ? "Account settings" : "Sign in"}
          </Button>
          <Button
            variant="secondary"
            disabled={
              actions.claim.access !== "available" ||
              pending !== null ||
              data.mode === "claimed_inbox"
            }
            title={reason(actions.claim)}
            onClick={() =>
              void run("claim", () =>
                actions.claim.access === "available" ? actions.claim.execute() : Promise.resolve(),
              )
            }
          >
            {data.mode === "claimed_inbox" ? "Claimed" : "Claim to workspace"}
          </Button>
          {data.mode === "claimed_inbox" &&
          data.licenseAcceptance.required &&
          !data.licenseAcceptance.satisfied ? (
            <Button
              variant="secondary"
              disabled={actions.acceptLicense.access !== "available" || pending !== null}
              title={reason(actions.acceptLicense)}
              onClick={() =>
                void run("accept-license", () =>
                  actions.acceptLicense.access === "available"
                    ? actions.acceptLicense.execute()
                    : Promise.resolve(),
                )
              }
            >
              Accept license for this share
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={actions.importToLibrary.access !== "available" || pending !== null}
            title={reason(actions.importToLibrary)}
            onClick={() =>
              void run("import", () =>
                actions.importToLibrary.access === "available"
                  ? actions.importToLibrary.execute()
                  : Promise.resolve(),
              )
            }
          >
            Import to Library
          </Button>
        </div>
        <ConsentControls
          capable={signalCapable}
          terms={terms}
          downloadLifecycle={downloadLifecycle}
          signals={signals}
          setTerms={setTerms}
          setDownloadLifecycle={setDownloadLifecycle}
          setSignals={setSignals}
        />
        <div>
          <Button
            className="w-full"
            disabled={actionBlocked || actions.download.access !== "available" || pending !== null}
            title={reason(actions.download)}
            onClick={() =>
              void run("download", async () => {
                if (actions.download.access === "available")
                  await actions.download.execute(downloadConsent());
              })
            }
          >
            <DownloadIcon /> Download
          </Button>
        </div>
        {failureNotice ? (
          <ActionFailureNotice action={failureNotice.action} failure={failureNotice.failure} />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RecipientShareScreen() {
  const contribution = useRecipientSharesModule().recipientShares;
  if (!contribution || contribution.access === "unavailable") {
    return (
      <ErrorState
        kind="forbidden"
        message={contribution?.reason ?? "This host does not support recipient shares."}
        retry={() => undefined}
      />
    );
  }
  return <AvailableRecipientShare contribution={contribution} />;
}

function AvailableRecipientShare({
  contribution,
}: {
  contribution: Extract<DashboardRecipientSharesContribution, { access: "available" }>;
}) {
  const share = contribution.useShare();
  const actions = contribution.useActions(share.data);
  if (share.isLoading)
    return (
      <main className="mx-auto grid min-h-screen w-full max-w-6xl gap-4 p-6 md:p-10">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-80 w-full" />
      </main>
    );
  if (share.error || !share.data)
    return (
      <ErrorState
        kind={share.errorKind}
        message={share.error ?? "This share is unavailable."}
        retry={share.refresh}
      />
    );
  const data = share.data;
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto grid w-full max-w-6xl gap-6 p-5 md:p-10">
        <header className="grid gap-3 border-b border-border pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{data.mode === "claimed_inbox" ? "Claimed share" : "Shared skill"}</Badge>
            <Badge variant="outline">Expires {new Date(data.expiresAt).toLocaleString()}</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            {data.disclosure.artifact.subjectId}
          </h1>
          <p className="max-w-3xl text-muted-foreground">
            Review the exact package, rights, provenance, and data-sharing choices before deciding
            what to do. Viewing this page does not install SelfTune or the skill.
          </p>
        </header>
        <Disclosure data={data} />
        <Actions actions={actions} data={data} />
      </div>
    </main>
  );
}

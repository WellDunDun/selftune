"use client";

import { CheckIcon, UploadIcon } from "lucide-react";

import type {
  ProjectSkillSetModel,
  ProjectSkillSetPublishPreviewModel,
  ProjectSkillSetReleaseReceiptModel,
} from "../../models";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@selftune/ui/primitives";
import { CONNECTION_LABELS } from "./skill-set-constants";

function packageSize(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength} bytes`;
  return `${Math.ceil(byteLength / 1_024)} KB`;
}

function TechnicalDetails({
  preview,
  receipt,
}: {
  preview?: ProjectSkillSetPublishPreviewModel;
  receipt?: ProjectSkillSetReleaseReceiptModel;
}) {
  const revisionSha256 = receipt?.skillSetRevisionSha256 ?? preview?.skillSetRevisionSha256;
  const envelopeSha256 = receipt?.envelopeSha256 ?? preview?.envelopeSha256;
  return (
    <details className="rounded-lg border border-dashed px-3 py-2.5 text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        Technical details
      </summary>
      <dl className="mt-3 grid gap-3 border-t pt-3 text-xs">
        {receipt ? (
          <div>
            <dt className="text-muted-foreground">Release ID</dt>
            <dd className="mt-1 break-all font-mono">{receipt.releaseId}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted-foreground">Skill Set revision SHA-256</dt>
          <dd className="mt-1 break-all font-mono">{revisionSha256}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Portable envelope SHA-256</dt>
          <dd className="mt-1 break-all font-mono">{envelopeSha256}</dd>
        </div>
        {preview ? (
          <div>
            <dt className="text-muted-foreground">Portable package size</dt>
            <dd className="mt-1 font-mono">{packageSize(preview.byteLength)}</dd>
          </div>
        ) : null}
        {receipt ? (
          <div>
            <dt className="text-muted-foreground">Published</dt>
            <dd className="mt-1">{new Date(receipt.publishedAt).toLocaleString()}</dd>
          </div>
        ) : null}
      </dl>
      {preview ? (
        <ul className="mt-3 space-y-2 border-t pt-3" aria-label="Included revision hashes">
          {preview.contents.map((item) => (
            <li key={`${item.name}:${item.revisionSha256}`} className="text-xs">
              <p className="font-medium">{item.name}</p>
              <p className="mt-0.5 break-all font-mono text-muted-foreground">
                {item.revisionSha256}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function PublishSkillSetDialog({
  skillSet,
  open,
  onOpenChange,
  preview,
  receipt,
  previewPending,
  publishPending,
  error,
  onPublish,
}: {
  skillSet: ProjectSkillSetModel;
  open: boolean;
  onOpenChange(open: boolean): void;
  preview: ProjectSkillSetPublishPreviewModel | null;
  receipt: ProjectSkillSetReleaseReceiptModel | null;
  previewPending: boolean;
  publishPending: boolean;
  error: string | null;
  onPublish(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {receipt
              ? "Published to team"
              : (preview?.confirmation.title ?? `Review ${skillSet.name}`)}
          </DialogTitle>
          <DialogDescription>
            This creates a team release. It does not send a link or install it.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {receipt ? (
          <div className="grid gap-4">
            <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckIcon className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="font-medium">
                  {receipt.idempotent
                    ? `Release ${receipt.sequence} was already published.`
                    : `Release ${receipt.sequence} is ready.`}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This immutable release is now available to your team. It has not been installed on
                  anyone&apos;s device.
                </p>
              </div>
            </div>
            <TechnicalDetails receipt={receipt} />
          </div>
        ) : preview ? (
          <div className="grid gap-5">
            <section className="grid gap-3" aria-labelledby="publish-contents-title">
              <div className="flex items-center justify-between gap-3">
                <h3 id="publish-contents-title" className="text-sm font-medium">
                  What your team will receive
                </h3>
                <Badge variant="outline">
                  {preview.contents.length} skill{preview.contents.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <ul className="divide-y rounded-lg border">
                {preview.contents.map((item) => (
                  <li
                    key={`${item.name}:${item.revisionSha256}`}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <span className="font-medium">{item.name}</span>
                    <span className="text-xs text-muted-foreground">{item.license} license</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                For{" "}
                {preview.connections.map((connection) => CONNECTION_LABELS[connection]).join(", ")}.
              </p>
            </section>

            <section className="grid gap-3" aria-labelledby="publish-checks-title">
              <h3 id="publish-checks-title" className="text-sm font-medium">
                Checks
              </h3>
              <ul className="grid gap-2">
                {preview.checks.map((check) => (
                  <li
                    key={check.id}
                    className="flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-2.5"
                  >
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium">{check.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="grid gap-3" aria-labelledby="publish-impact-title">
              <h3 id="publish-impact-title" className="text-sm font-medium">
                Package impact
              </h3>
              <div className="rounded-lg border px-3 py-2.5 text-sm">
                <p className="font-medium">
                  {preview.dependencies.impact.added.length} package
                  {preview.dependencies.impact.added.length === 1 ? "" : "s"} added
                  {preview.dependencies.impact.changed.length > 0
                    ? ` · ${preview.dependencies.impact.changed.length} changed`
                    : ""}
                  {preview.dependencies.impact.removed.length > 0
                    ? ` · ${preview.dependencies.impact.removed.length} removed`
                    : ""}
                </p>
                {preview.dependencies.lock.entries.length > 0 ? (
                  <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                    {preview.dependencies.impact.added.map((entry) => (
                      <li key={`added:${entry}`}>{entry}</li>
                    ))}
                    {preview.dependencies.impact.removed.map((entry) => (
                      <li key={`removed:${entry}`}>{entry}</li>
                    ))}
                    {preview.dependencies.impact.changed.map((entry) => (
                      <li key={`changed:${entry.package_id}`}>
                        {entry.package_id}: {entry.from} → {entry.to}
                      </li>
                    ))}
                    {preview.dependencies.impact.unchanged.map((entry) => (
                      <li key={`unchanged:${entry}`}>{entry} unchanged</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>

            <p className="text-sm text-muted-foreground">{preview.confirmation.detail}</p>

            <TechnicalDetails preview={preview} />
          </div>
        ) : previewPending ? (
          <div className="grid gap-3" aria-label="Preparing publish preview" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {receipt ? "Done" : "Cancel"}
          </Button>
          {preview && !receipt ? (
            <Button disabled={publishPending} onClick={onPublish}>
              <UploadIcon data-icon="inline-start" />
              {publishPending ? "Publishing…" : "Publish to team"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

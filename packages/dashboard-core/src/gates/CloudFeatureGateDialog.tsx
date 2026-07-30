import type { ReactNode } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@selftune/ui/primitives";

export type CloudFeatureGateKind = "skill-set" | "skill-share" | "skill-backup";

interface CloudFeatureGateContext {
  name?: string;
  detail?: string;
}

interface CloudFeatureGateDialogProps {
  kind: CloudFeatureGateKind;
  open: boolean;
  onOpenChange(open: boolean): void;
  upgradeHref: string;
  context?: CloudFeatureGateContext;
  trigger?: ReactNode;
}

export interface CloudFeatureGateContent {
  title: string;
  description: string;
  previewLabel: string;
  previewName: string;
  previewDetail: string;
  benefits: ReadonlyArray<readonly [title: string, description: string]>;
  channels: readonly string[];
}

export function cloudFeatureGateContent(
  kind: CloudFeatureGateKind,
  context: CloudFeatureGateContext = {},
): CloudFeatureGateContent {
  if (kind === "skill-share") {
    return {
      title: "Share this skill by link",
      description:
        "Back up the skill to SelfTune Cloud, then create an expiring link to its exact immutable package without granting repository access or passing around a ZIP file.",
      previewLabel: "Shared skill",
      previewName: context.name ?? "Selected skill",
      previewDetail: context.detail ?? "Exact package revision from your Cloud Library",
      benefits: [
        ["Exact revision", "The link downloads the immutable package revision you shared."],
        ["Revocable link", "The link expires automatically and can be revoked earlier."],
        [
          "No repository setup",
          "Recipients do not need contributor access to your source repository.",
        ],
        ["Direct download", "Recipients download the package directly from the link."],
      ],
      channels: ["Copy link"],
    };
  }

  if (kind === "skill-backup") {
    return {
      title: "Keep this skill available everywhere",
      description:
        "Save a private, immutable revision in SelfTune Cloud so you can install it on another computer or sandbox without creating a repository.",
      previewLabel: "Cloud backup",
      previewName: context.name ?? "Selected skill",
      previewDetail: context.detail ?? "A pinned revision will be stored in your Cloud Library",
      benefits: [
        ["Your machines first", "Restore the same revision on another computer or sandbox."],
        ["Private by default", "The backup remains private until you choose to share it."],
        [
          "Pinned revisions",
          "Install the exact content you backed up instead of whichever files happen to be current.",
        ],
        [
          "No repository required",
          "Move a local skill between environments without Git or ZIP files.",
        ],
      ],
      channels: ["My devices", "Sandboxes"],
    };
  }

  return {
    title: "Use this Skill Set anywhere",
    description:
      "Keep a private copy in SelfTune Cloud, use the same pinned revisions on your other machines and sandboxes, or share the exact immutable package by reusable link.",
    previewLabel: "Portable Skill Set",
    previewName: context.name ?? "Selected Skill Set",
    previewDetail: context.detail ?? "Pinned revisions ready for your Cloud Library",
    benefits: [
      ["Your machines first", "Install the exact pinned revisions on another computer or sandbox."],
      [
        "Private by default",
        "Your Cloud Library stays private until you explicitly share from it.",
      ],
      [
        "No repository setup",
        "Share a direct package link instead of granting repository access or sending a ZIP.",
      ],
      ["Revocable link", "The reusable link expires automatically and can be revoked earlier."],
    ],
    channels: ["My devices", "Sandboxes", "Copy link"],
  };
}

export function CloudFeatureGateDialog({
  kind,
  open,
  onOpenChange,
  upgradeHref,
  context,
  trigger,
}: CloudFeatureGateDialogProps) {
  const content = cloudFeatureGateContent(kind, context);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <div className="grid md:grid-cols-[1.15fr_0.85fr]">
          <div className="flex flex-col p-6 sm:p-8">
            <DialogHeader className="gap-3 pr-6">
              <span className="w-fit rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                SelfTune Cloud
              </span>
              <DialogTitle className="text-2xl leading-tight tracking-tight">
                {content.title}
              </DialogTitle>
              <DialogDescription className="max-w-md leading-relaxed">
                {content.description}
              </DialogDescription>
            </DialogHeader>

            <ul className="mt-7 grid gap-4" aria-label="Cloud Library benefits">
              {content.benefits.map(([title, description], index) => (
                <li key={title} className="grid grid-cols-[1.5rem_1fr] gap-3">
                  <span
                    className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span>
                    <span className="block font-medium">{title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t bg-muted/35 p-6 md:border-t-0 md:border-l sm:p-8">
            <div className="flex h-full min-h-72 flex-col justify-between rounded-2xl border bg-background p-5 shadow-sm">
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {content.previewLabel}
                </p>
                <p className="mt-2 text-lg font-semibold tracking-tight">{content.previewName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{content.previewDetail}</p>
              </div>

              <div className="my-6 grid gap-2">
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
                  <span className="font-medium">Local Library</span>
                  <span className="text-xs text-muted-foreground">Current</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
                  <span className="font-medium">SelfTune Cloud</span>
                  <span className="text-xs text-muted-foreground">Ready to connect</span>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">Use it across</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {content.channels.map((channel) => (
                    <span
                      key={channel}
                      className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium"
                    >
                      {channel}
                    </span>
                  ))}
                </div>
                <p className="mt-4 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
                  Installed skills contain readable files and may be copied outside SelfTune. Usage
                  telemetry stays off until separately enabled.
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="m-0 rounded-none px-6 py-4 sm:px-8">
          <Button
            variant="ghost"
            nativeButton={false}
            render={<a href="https://docs.selftune.dev/guides/sharing-skills" />}
          >
            Learn more
          </Button>
          <Button nativeButton={false} render={<a href={upgradeHref} />}>
            Connect to SelfTune Cloud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

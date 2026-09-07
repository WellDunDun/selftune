"use client";
import { CheckIcon, CopyIcon, LibraryIcon } from "lucide-react";
import { useState } from "react";
import type { LibrarySkillModel } from "../../models";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@selftune/ui/primitives";
import type { DashboardLibraryActions } from "../../host";
import { OnDemandSkillsReview } from "./OnDemandSkillsReview";
import { ContextSavings } from "./ContextSavings";

export const ON_DEMAND_SKILL_PROMPT =
  "Use the Corey Haines marketing skills for this task. Find the exact local collection with SelfTune, activate it only in this project for this task, and remove it when we are done.";
export const ON_DEMAND_SETUP_KEY = "selftune-on-demand-setup-dismissed";
export function estimateInstructionTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}
export function OnDemandSkillsPanel({
  skills,
  actions,
  refresh,
}: {
  skills: readonly LibrarySkillModel[];
  actions?: DashboardLibraryActions;
  refresh?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(ON_DEMAND_SETUP_KEY) !== "true";
    } catch {
      return true;
    }
  });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const count = skills.filter(
    (skill) => skill.lifecycle === "library" || skill.lifecycle === "draft",
  ).length;
  const dismiss = () => {
    setOpen(false);
    try {
      globalThis.localStorage?.setItem(ON_DEMAND_SETUP_KEY, "true");
    } catch {
      /* Storage may be disabled; dismissal still works for this mount. */
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(ON_DEMAND_SKILL_PROMPT);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };
  const introduction = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{count}</span> skills ready without project
        installs.
      </p>
      <details className="rounded-lg border bg-muted/35 p-3">
        <summary className="cursor-pointer text-sm font-medium">How to ask your agent</summary>
        <p className="mt-2 font-mono text-xs leading-5">{ON_DEMAND_SKILL_PROMPT}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void copyPrompt()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy example request"}
          </Button>
          {copyFailed ? (
            <span className="text-xs text-destructive" role="status">
              Copy failed. Select the request text instead.
            </span>
          ) : null}
          <a href="https://docs.selftune.dev/cli/skills-search" className="text-xs underline">
            How temporary skills work
          </a>
        </div>
      </details>
    </div>
  );
  if (actions && refresh && actions.moveToLibraryMany?.access === "available") {
    return (
      <OnDemandSkillsReview
        skills={skills}
        actions={actions}
        refresh={refresh}
        introduction={introduction}
        initialOpen={open}
        onDismiss={dismiss}
      />
    );
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <LibraryIcon /> Use on demand
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Keep skills for on-demand use</DialogTitle>
            <DialogDescription>
              Keep occasional skills in your searchable Library and load them only for the task that
              needs them.
            </DialogDescription>
          </DialogHeader>
          {introduction}
          <ContextSavings skills={skills} />
          <Button variant="outline" onClick={dismiss}>
            Done
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

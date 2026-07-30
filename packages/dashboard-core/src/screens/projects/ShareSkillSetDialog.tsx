"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, MailIcon, Share2Icon } from "lucide-react";

import type { DashboardProjectsActions } from "../../host";
import type { ProjectSkillSetModel } from "../../models";
import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@selftune/ui/primitives";

export function ShareSkillSetDialog({
  skillSet,
  open,
  onOpenChange,
  action,
  recipients = [],
  workspaceAction,
}: {
  skillSet: ProjectSkillSetModel;
  open: boolean;
  onOpenChange(open: boolean): void;
  action: Extract<NonNullable<DashboardProjectsActions["share"]>, { access: "available" }>;
  recipients?: ReturnType<NonNullable<DashboardProjectsActions["useShareRecipients"]>>;
  workspaceAction?: DashboardProjectsActions["shareWithWorkspace"];
}) {
  const supportsEmail = action.supportedDeliveryMethods?.includes("email") ?? true;
  const supportsPrivateClaim = action.supportedShareModes?.includes("private_single_claim") ?? true;
  const [delivery, setDelivery] = useState<"copy_link" | "email">("copy_link");
  const [mode, setMode] = useState<"reusable_unlisted" | "private_single_claim">(
    "reusable_unlisted",
  );
  const [email, setEmail] = useState("");
  const [workspaceSelected, setWorkspaceSelected] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setShareUrl(null);
    setSent(false);
    setError(null);
  }, [open]);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      if (delivery === "email" && !supportsEmail) {
        throw new Error("Email, member, and workspace sharing are unavailable from this host.");
      }
      if (delivery === "email" && workspaceSelected) {
        if (workspaceAction?.access !== "available") {
          throw new Error("Workspace sharing is unavailable.");
        }
        await workspaceAction.execute(skillSet.id);
        setSent(true);
        return;
      }
      const receipt = await action.execute(
        delivery === "email"
          ? {
              skillSetId: skillSet.id,
              mode: "private_single_claim",
              delivery: "email",
              recipientEmail: email.trim().toLowerCase(),
            }
          : { skillSetId: skillSet.id, mode, delivery: "copy_link" },
      );
      setShareUrl(receipt.shareUrl ?? null);
      setSent(receipt.delivery === "email");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Skill Set could not be shared.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share {skillSet.name}</DialogTitle>
          <DialogDescription>
            Share this Skill Set and all of its pinned skills as one portable package.
          </DialogDescription>
        </DialogHeader>
        {shareUrl ? (
          <div className="flex gap-2">
            <Input aria-label="Skill Set share link" readOnly value={shareUrl} />
            <Button
              variant="outline"
              aria-label="Copy Skill Set share link"
              onClick={() => void navigator.clipboard.writeText(shareUrl)}
            >
              <CopyIcon />
            </Button>
          </div>
        ) : sent ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckIcon className="size-4" />
            {workspaceSelected
              ? "Shared with everyone in this workspace."
              : `Invitation sent to ${email.trim().toLowerCase()}.`}
          </div>
        ) : (
          <div className="grid gap-4">
            {supportsEmail ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={delivery === "copy_link" ? "default" : "outline"}
                  onClick={() => setDelivery("copy_link")}
                >
                  <Share2Icon /> Copy link
                </Button>
                <Button
                  type="button"
                  variant={delivery === "email" ? "default" : "outline"}
                  onClick={() => setDelivery("email")}
                >
                  <MailIcon /> People &amp; workspace
                </Button>
              </div>
            ) : null}
            {delivery === "copy_link" ? (
              <div className="grid gap-2">
                {supportsPrivateClaim ? (
                  <>
                    <Label htmlFor="skill-set-share-mode">Who can use this link?</Label>
                    <select
                      id="skill-set-share-mode"
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={mode}
                      onChange={(event) =>
                        setMode(event.target.value as "reusable_unlisted" | "private_single_claim")
                      }
                    >
                      <option value="reusable_unlisted">Anyone with the link</option>
                      <option value="private_single_claim">First person only</option>
                    </select>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="skill-set-recipient-email">Share with</Label>
                <Combobox<string>
                  items={[
                    ...(workspaceAction?.access === "available" ? ["__workspace__"] : []),
                    ...recipients.map((recipient) => recipient.email),
                    ...(email.trim().length > 0 &&
                    !recipients.some(
                      (recipient) => recipient.email.toLowerCase() === email.trim().toLowerCase(),
                    )
                      ? [email]
                      : []),
                  ]}
                  inputValue={email}
                  itemToStringLabel={(value) =>
                    value === "__workspace__" ? "Entire workspace" : value
                  }
                  onInputValueChange={(value) => {
                    setEmail(value);
                    if (value !== "Entire workspace") setWorkspaceSelected(false);
                  }}
                  onValueChange={(value) => {
                    setWorkspaceSelected(value === "__workspace__");
                    setEmail(value === "__workspace__" ? "Entire workspace" : (value ?? ""));
                  }}
                >
                  <ComboboxInput
                    id="skill-set-recipient-email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="Select a member or enter email"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>Type a recipient email.</ComboboxEmpty>
                    <ComboboxList>
                      {workspaceAction?.access === "available" ? (
                        <ComboboxItem value="__workspace__">Entire workspace</ComboboxItem>
                      ) : null}
                      {recipients.map((recipient) => (
                        <ComboboxItem key={recipient.email} value={recipient.email}>
                          <span className="min-w-0">
                            <span className="block truncate">
                              {recipient.name ?? recipient.email}
                            </span>
                            {recipient.name ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {recipient.email}
                              </span>
                            ) : null}
                          </span>
                        </ComboboxItem>
                      ))}
                      {email.trim().length > 0 &&
                      email !== "Entire workspace" &&
                      !recipients.some(
                        (recipient) => recipient.email.toLowerCase() === email.trim().toLowerCase(),
                      ) ? (
                        <ComboboxItem value={email}>{email.trim().toLowerCase()}</ComboboxItem>
                      ) : null}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Every included skill must have distributable license evidence. Usage telemetry is off
              unless the recipient separately opts in.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!shareUrl && !sent ? (
            <Button
              disabled={
                pending || (delivery === "email" && !workspaceSelected && email.trim().length === 0)
              }
              onClick={() => void submit()}
            >
              {pending
                ? "Preparing package…"
                : delivery === "email"
                  ? workspaceSelected
                    ? "Share with workspace"
                    : "Send invite"
                  : "Create link"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, MailIcon, Share2Icon } from "lucide-react";

import type { DashboardLibraryActions } from "../../host";
import type { LibraryShareMode, LibrarySkillModel } from "../../models";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@selftune/ui/primitives";

export function ShareSkillDialog({
  skill,
  action,
  open,
  onOpenChange,
}: {
  skill: LibrarySkillModel;
  action: NonNullable<DashboardLibraryActions["share"]>;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const supportsEmail = action.supportedDeliveryMethods?.includes("email") ?? true;
  const supportsPrivateClaim = action.supportedShareModes?.includes("private_single_claim") ?? true;
  const [delivery, setDelivery] = useState<"copy_link" | "email">("copy_link");
  const [mode, setMode] = useState<LibraryShareMode>("reusable_unlisted");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const reset = () => {
    setError(null);
    setShareUrl(null);
    setSent(false);
  };

  const submit = async () => {
    if (action.access !== "available") return;
    setPending(true);
    setError(null);
    try {
      if (delivery === "email" && !supportsEmail) {
        throw new Error("Email sharing is unavailable from this host.");
      }
      const receipt = await action.execute(
        delivery === "email"
          ? {
              skillId: skill.id,
              mode: "private_single_claim",
              delivery: "email",
              recipientEmail: email.trim().toLowerCase(),
            }
          : { skillId: skill.id, mode, delivery: "copy_link" },
      );
      setShareUrl(receipt.shareUrl ?? null);
      setSent(delivery === "email");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {skill.name}</DialogTitle>
          <DialogDescription>
            {supportsEmail
              ? "Send an invitation or copy a link. Recipients review the license before installing. Usage telemetry is off unless the recipient separately opts in."
              : "Copy a link to the exact immutable package. Usage telemetry is off unless the recipient separately opts in."}
          </DialogDescription>
        </DialogHeader>

        {shareUrl ? (
          <div className="grid gap-3">
            <Label htmlFor="share-url">Share link</Label>
            <div className="flex gap-2">
              <Input id="share-url" readOnly value={shareUrl} />
              <Button
                variant="outline"
                aria-label="Copy share link"
                onClick={() => void navigator.clipboard.writeText(shareUrl)}
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
        ) : sent ? (
          <div className="flex items-center gap-2 rounded-md border p-4 text-sm">
            <CheckIcon className="size-4" /> Invitation sent to {email.trim().toLowerCase()}.
          </div>
        ) : (
          <Tabs
            value={delivery}
            onValueChange={(value) => {
              setDelivery(value as "copy_link" | "email");
              setError(null);
            }}
          >
            <TabsList className={`grid w-full ${supportsEmail ? "grid-cols-2" : "grid-cols-1"}`}>
              <TabsTrigger value="copy_link">
                <Share2Icon /> Copy link
              </TabsTrigger>
              {supportsEmail ? (
                <TabsTrigger value="email">
                  <MailIcon /> Email invite
                </TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="copy_link" className="grid gap-3 pt-3">
              {supportsPrivateClaim ? (
                <>
                  <Label htmlFor="share-link-kind">Who can use this link?</Label>
                  <select
                    id="share-link-kind"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={mode}
                    onChange={(event) => setMode(event.target.value as LibraryShareMode)}
                  >
                    <option value="reusable_unlisted">Anyone with the link</option>
                    <option value="private_single_claim">One person (first claim)</option>
                  </select>
                </>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {!supportsPrivateClaim || mode === "reusable_unlisted"
                  ? "The link works until it expires or you revoke it."
                  : "The first signed-in recipient claims it; it cannot be claimed again."}
              </p>
            </TabsContent>
            {supportsEmail ? (
              <TabsContent value="email" className="grid gap-3 pt-3">
                <Label htmlFor="share-recipient-email">Recipient email</Label>
                <Input
                  id="share-recipient-email"
                  type="email"
                  autoComplete="email"
                  placeholder="person@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This private invitation can only be claimed by an account with this email.
                </p>
              </TabsContent>
            ) : null}
          </Tabs>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!shareUrl && !sent ? (
            <Button
              disabled={
                pending || action.access !== "available" || (delivery === "email" && !email.trim())
              }
              onClick={() => void submit()}
            >
              {pending ? "Sharing…" : delivery === "email" ? "Send invite" : "Create link"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

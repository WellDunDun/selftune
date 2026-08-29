"use client";

import { useState } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  FileKey2Icon,
  MailIcon,
  Share2Icon,
} from "lucide-react";

import type { DashboardLibraryActions } from "../../host";
import type {
  LibraryLicenseDraftPreviewModel,
  LibraryShareMode,
  LibrarySkillModel,
} from "../../models";
import { PierreDiffReview } from "@selftune/ui/components";
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
  previewLicenseAction,
  applyLicenseAction,
  open,
  onOpenChange,
}: {
  skill: LibrarySkillModel;
  action: NonNullable<DashboardLibraryActions["share"]>;
  previewLicenseAction?: DashboardLibraryActions["previewLicenseDraft"];
  applyLicenseAction?: DashboardLibraryActions["applyLicenseDraft"];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [delivery, setDelivery] = useState<"copy_link" | "email">("copy_link");
  const [mode, setMode] = useState<LibraryShareMode>("reusable_unlisted");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [draftingLicense, setDraftingLicense] = useState(false);
  const [copyrightHolder, setCopyrightHolder] = useState("");
  const [licensedOrganization, setLicensedOrganization] = useState("");
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [licensePreview, setLicensePreview] = useState<LibraryLicenseDraftPreviewModel | null>(
    null,
  );
  const resolvedTheme =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";

  const reset = () => {
    setError(null);
    setShareUrl(null);
    setSent(false);
    setDraftingLicense(false);
    setLicensePreview(null);
  };

  const terms = () => ({
    copyrightHolder: copyrightHolder.trim(),
    licensedOrganization: licensedOrganization.trim(),
    year: Number(year),
  });

  const previewLicense = async () => {
    if (previewLicenseAction?.access !== "available") return;
    setPending(true);
    setError(null);
    try {
      setLicensePreview(await previewLicenseAction.execute({ skillId: skill.id, terms: terms() }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const applyLicense = async () => {
    if (applyLicenseAction?.access !== "available" || !licensePreview) return;
    setPending(true);
    setError(null);
    try {
      await applyLicenseAction.execute({
        skillId: skill.id,
        previewId: licensePreview.previewId,
        terms: terms(),
      });
      setDraftingLicense(false);
      setLicensePreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const submit = async () => {
    if (action.access !== "available") return;
    setPending(true);
    setError(null);
    try {
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
      <DialogContent className={draftingLicense ? "sm:max-w-5xl" : "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle>
            {draftingLicense ? `Draft a license for ${skill.name}` : `Share ${skill.name}`}
          </DialogTitle>
          <DialogDescription>
            {draftingLicense
              ? "Draft internal-use terms, then review the exact files and diff before anything is written. This is a drafting aid, not legal advice."
              : "Send an invitation or copy a link. Recipients review the license before installing. Usage telemetry is off unless the recipient separately opts in."}
          </DialogDescription>
        </DialogHeader>

        {draftingLicense ? (
          <div className="grid gap-4">
            {licensePreview ? (
              <>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{licensePreview.licenseExpression}</span>
                  <Button variant="ghost" size="sm" onClick={() => setLicensePreview(null)}>
                    Edit terms
                  </Button>
                </div>
                <PierreDiffReview files={licensePreview.files} theme={resolvedTheme} />
              </>
            ) : (
              <div className="grid gap-4 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="license-holder">Copyright holder</Label>
                  <Input
                    id="license-holder"
                    placeholder="Daniel Petro"
                    value={copyrightHolder}
                    onChange={(event) => setCopyrightHolder(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="licensed-organization">Licensed organization</Label>
                  <Input
                    id="licensed-organization"
                    placeholder="Ithraa Center"
                    value={licensedOrganization}
                    onChange={(event) => setLicensedOrganization(event.target.value)}
                  />
                </div>
                <div className="grid gap-2 sm:max-w-40">
                  <Label htmlFor="license-year">Copyright year</Label>
                  <Input
                    id="license-year"
                    inputMode="numeric"
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                  />
                </div>
                <p className="self-end text-xs leading-5 text-muted-foreground">
                  The draft permits internal use, modification, and private distribution to
                  authorized personnel. External redistribution remains prohibited.
                </p>
              </div>
            )}
          </div>
        ) : shareUrl ? (
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
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="copy_link">
                <Share2Icon /> Copy link
              </TabsTrigger>
              <TabsTrigger value="email">
                <MailIcon /> Email invite
              </TabsTrigger>
            </TabsList>
            <TabsContent value="copy_link" className="grid gap-3 pt-3">
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
              <p className="text-xs text-muted-foreground">
                {mode === "reusable_unlisted"
                  ? "The link works until it expires or you revoke it."
                  : "The first signed-in recipient claims it; it cannot be claimed again."}
              </p>
            </TabsContent>
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
          </Tabs>
        )}

        {error ? (
          <div className="grid gap-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            {!draftingLicense &&
            previewLicenseAction?.access === "available" &&
            applyLicenseAction?.access === "available" &&
            /license/i.test(error) ? (
              <Button
                variant="outline"
                className="justify-self-start"
                onClick={() => {
                  setError(null);
                  setDraftingLicense(true);
                }}
              >
                <FileKey2Icon /> Draft a license
              </Button>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {draftingLicense ? (
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setDraftingLicense(false);
                setLicensePreview(null);
              }}
            >
              <ArrowLeftIcon /> Back to sharing
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
          {draftingLicense ? (
            <Button
              disabled={
                pending ||
                (!licensePreview &&
                  (!copyrightHolder.trim() || !licensedOrganization.trim() || !Number(year)))
              }
              onClick={() => void (licensePreview ? applyLicense() : previewLicense())}
            >
              {pending ? "Working…" : licensePreview ? "Apply reviewed license" : "Review draft"}
            </Button>
          ) : !shareUrl && !sent ? (
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

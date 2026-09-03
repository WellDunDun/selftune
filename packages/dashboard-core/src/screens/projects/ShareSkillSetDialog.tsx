"use client";

import { useEffect, useState, type ComponentProps, type ComponentType } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  FileKey2Icon,
  MailIcon,
  Share2Icon,
} from "lucide-react";

import type { DashboardLibraryActions, DashboardProjectsActions } from "../../host";
import type { LibraryLicenseDraftPreviewModel, ProjectSkillSetModel } from "../../models";
import { PierreDiffReview } from "@selftune/ui/components";
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

const DEFAULT_SHARE_LINK_MODES = ["reusable_unlisted", "private_single_claim"] as const;
const EMPTY_SHARE_RECIPIENTS: ReturnType<
  NonNullable<DashboardProjectsActions["useShareRecipients"]>
> = [];
const DEFAULT_DIFF_REVIEW = PierreDiffReview;
type DiffReviewComponent = ComponentType<ComponentProps<typeof PierreDiffReview>>;

export function ShareSkillSetDialog({
  skillSet,
  open,
  onOpenChange,
  action,
  recipients = EMPTY_SHARE_RECIPIENTS,
  workspaceAction,
  previewLicenseAction,
  applyLicenseAction,
  DiffReview = DEFAULT_DIFF_REVIEW,
  onShared,
}: {
  skillSet: ProjectSkillSetModel;
  open: boolean;
  onOpenChange(open: boolean): void;
  action: Extract<NonNullable<DashboardProjectsActions["share"]>, { access: "available" }>;
  recipients?: ReturnType<NonNullable<DashboardProjectsActions["useShareRecipients"]>>;
  workspaceAction?: DashboardProjectsActions["shareWithWorkspace"];
  previewLicenseAction?: DashboardLibraryActions["previewLicenseDraft"];
  applyLicenseAction?: DashboardLibraryActions["applyLicenseDraft"];
  DiffReview?: DiffReviewComponent;
  onShared?(): void | Promise<void>;
}) {
  const linkModes = action.capabilities?.linkModes ?? DEFAULT_SHARE_LINK_MODES;
  const supportsEmail = action.capabilities?.deliveries.includes("email") ?? true;
  const defaultMode = linkModes[0] ?? "private_single_claim";
  const [delivery, setDelivery] = useState<"copy_link" | "email">("copy_link");
  const [mode, setMode] = useState<"reusable_unlisted" | "private_single_claim">(defaultMode);
  const [email, setEmail] = useState("");
  const [workspaceSelected, setWorkspaceSelected] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftingLicense, setDraftingLicense] = useState(false);
  const [draftSkillId, setDraftSkillId] = useState(skillSet.skills[0]?.name ?? "");
  const [copyrightHolder, setCopyrightHolder] = useState("");
  const [licensedOrganization, setLicensedOrganization] = useState("");
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [licensePreview, setLicensePreview] = useState<LibraryLicenseDraftPreviewModel | null>(
    null,
  );
  const resolvedTheme = document.documentElement.classList.contains("dark") ? "dark" : "light";

  useEffect(() => {
    if (open) return;
    setShareUrl(null);
    setSent(false);
    setError(null);
    setDraftingLicense(false);
    setLicensePreview(null);
  }, [open]);

  useEffect(() => {
    if (!linkModes.includes(mode)) setMode(defaultMode);
    if (!supportsEmail && delivery === "email") setDelivery("copy_link");
  }, [defaultMode, delivery, linkModes, mode, supportsEmail]);

  const terms = () => ({
    copyrightHolder: copyrightHolder.trim(),
    licensedOrganization: licensedOrganization.trim(),
    year: Number(year),
  });

  async function previewLicense() {
    if (previewLicenseAction?.access !== "available") return;
    setPending(true);
    setError(null);
    try {
      setLicensePreview(
        await previewLicenseAction.execute({
          skillId: draftSkillId,
          skillSetId: skillSet.id,
          terms: terms(),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function applyLicense() {
    if (applyLicenseAction?.access !== "available" || !licensePreview) return;
    setPending(true);
    setError(null);
    try {
      await applyLicenseAction.execute({
        skillId: draftSkillId,
        skillSetId: skillSet.id,
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
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
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
      await onShared?.();
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
      <DialogContent className={draftingLicense ? "sm:max-w-5xl" : undefined}>
        <DialogHeader>
          <DialogTitle>
            {draftingLicense
              ? `Draft license for ${skillSet.name}`
              : `Send a link for ${skillSet.name}`}
          </DialogTitle>
          <DialogDescription>
            {draftingLicense
              ? "Choose the unlicensed skill, draft internal-use terms, and review the exact files before applying. This is a drafting aid, not legal advice."
              : "Create a package link for this Skill Set. This does not publish a team release or install it."}
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
                <DiffReview files={licensePreview.files} theme={resolvedTheme} />
              </>
            ) : (
              <div className="grid gap-4 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="skill-set-license-skill">Skill needing a license</Label>
                  <select
                    id="skill-set-license-skill"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={draftSkillId}
                    onChange={(event) => setDraftSkillId(event.target.value)}
                  >
                    {skillSet.skills.map((skill) => (
                      <option key={`${skill.name}:${skill.contentHash}`} value={skill.name}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="skill-set-license-holder">Copyright holder</Label>
                  <Input
                    id="skill-set-license-holder"
                    placeholder="Daniel Petro"
                    value={copyrightHolder}
                    onChange={(event) => setCopyrightHolder(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="skill-set-licensed-organization">Licensed organization</Label>
                  <Input
                    id="skill-set-licensed-organization"
                    placeholder="Ithraa Center"
                    value={licensedOrganization}
                    onChange={(event) => setLicensedOrganization(event.target.value)}
                  />
                </div>
                <div className="grid gap-2 sm:max-w-40">
                  <Label htmlFor="skill-set-license-year">Copyright year</Label>
                  <Input
                    id="skill-set-license-year"
                    inputMode="numeric"
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                  />
                </div>
                <p className="self-end text-xs leading-5 text-muted-foreground">
                  Internal use, modification, and private team distribution are permitted. External
                  redistribution remains prohibited.
                </p>
              </div>
            )}
          </div>
        ) : shareUrl ? (
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
                {linkModes.length > 1 ? (
                  <>
                    <Label htmlFor="skill-set-share-mode">Who can use this link?</Label>
                    <select
                      id="skill-set-share-mode"
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={mode}
                      onChange={(event) => {
                        if (
                          event.target.value === "reusable_unlisted" ||
                          event.target.value === "private_single_claim"
                        ) {
                          setMode(event.target.value);
                        }
                      }}
                    >
                      {linkModes.includes("reusable_unlisted") ? (
                        <option value="reusable_unlisted">Unlisted — anyone with the link</option>
                      ) : null}
                      {linkModes.includes("private_single_claim") ? (
                        <option value="private_single_claim">
                          Access-controlled — first person only
                        </option>
                      ) : null}
                    </select>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">One-time link</p>
                    <p className="text-xs text-muted-foreground">
                      This link can be used once. After the first successful claim, it no longer
                      works.
                    </p>
                  </>
                )}
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
          </div>
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
                <FileKey2Icon /> Draft missing license
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
                  (!draftSkillId ||
                    !copyrightHolder.trim() ||
                    !licensedOrganization.trim() ||
                    !Number(year)))
              }
              onClick={() => void (licensePreview ? applyLicense() : previewLicense())}
            >
              {pending ? "Working…" : licensePreview ? "Apply reviewed license" : "Review draft"}
            </Button>
          ) : !shareUrl && !sent ? (
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

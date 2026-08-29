"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  PackageOpenIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

import type { DashboardProjectsAction } from "../../host";
import type { ProjectSkillSetPackModel, ProjectSkillSetPacksQueryState } from "../../models";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@selftune/ui/components";
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

function packStatusLabel(status: ProjectSkillSetPackModel["status"]): string {
  if (status === "active") return "Active";
  if (status === "claimed") return "Claimed";
  if (status === "expired") return "Expired";
  return "Revoked";
}

function PackRowsSkeleton() {
  return (
    <div className="divide-y rounded-xl border" aria-label="Loading shared Packs" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_180px]">
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

function PackRow({
  pack,
  onRevoke,
}: {
  pack: ProjectSkillSetPackModel;
  onRevoke(pack: ProjectSkillSetPackModel): void;
}) {
  const [copied, setCopied] = useState(false);
  const isActive = pack.status === "active";
  const packUrl = pack.packUrl;
  const expires = new Date(pack.expiresAt);
  return (
    <article className="grid gap-5 px-1 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold tracking-tight">{pack.name}</h3>
          <Badge variant={isActive ? "secondary" : "outline"}>{packStatusLabel(pack.status)}</Badge>
          <Badge variant="outline">
            {pack.mode === "private_single_claim" ? "Single use" : "Reusable"}
          </Badge>
        </div>
        <p className="mt-1 line-clamp-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {pack.description || "Portable Skill Set Pack"}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{pack.componentCount} included skills</span>
          <span>
            Expires{" "}
            {Number.isNaN(expires.getTime()) ? pack.expiresAt : expires.toLocaleDateString()}
          </span>
          <span className="font-mono">{pack.skillSetRevisionSha256.slice(0, 10)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        {packUrl && isActive ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(packUrl).then(() => {
                  setCopied(true);
                  toast.success("Pack link copied");
                  return window.setTimeout(() => setCopied(false), 2_000);
                });
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy link"}
            </Button>
            <Button
              nativeButton={false}
              variant="outline"
              size="sm"
              render={<a href={packUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon /> Open
            </Button>
          </>
        ) : null}
        {isActive ? (
          <Button variant="ghost" size="sm" onClick={() => onRevoke(pack)}>
            <BanIcon /> Revoke
          </Button>
        ) : null}
      </div>
      {!pack.packUrl && isActive ? (
        <p className="text-xs text-muted-foreground md:col-span-2">
          This legacy link remains valid, but its one-way token cannot be copied again. Create a new
          Pack from the Skill Set when you need another link.
        </p>
      ) : null}
    </article>
  );
}

export function SharedSkillSetPacks({
  query,
  revoke,
  onCreatePack,
}: {
  query: ProjectSkillSetPacksQueryState;
  revoke: DashboardProjectsAction<string, void> | undefined;
  onCreatePack(): void;
}) {
  const [pendingRevoke, setPendingRevoke] = useState<ProjectSkillSetPackModel | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  if (query.isLoading) return <PackRowsSkeleton />;
  if (query.error) {
    return (
      <Empty className="rounded-xl border py-14">
        <EmptyHeader>
          <EmptyTitle>Shared Packs could not be loaded</EmptyTitle>
          <EmptyDescription>{query.error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => void query.refresh()}>
            <RefreshCwIcon /> Retry
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const packs = query.data ?? [];
  return (
    <section aria-labelledby="shared-packs-title" className="space-y-6">
      <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Distribution
          </p>
          <h2 id="shared-packs-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Shared Packs
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Copy active links, see when single-use Packs are claimed, and revoke access immediately.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void query.refresh()}>
            <RefreshCwIcon /> Refresh
          </Button>
          <Button onClick={onCreatePack}>
            <LinkIcon /> Share a Skill Set
          </Button>
        </div>
      </div>

      {packs.length === 0 ? (
        <Empty className="rounded-xl border py-16">
          <EmptyHeader>
            <PackageOpenIcon className="size-8 text-primary" />
            <EmptyTitle>No shared Packs yet</EmptyTitle>
            <EmptyDescription>
              Select a Skill Set and create a link. Recipients can review it in a browser and open
              it directly in SelfTune Desktop.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onCreatePack}>
              <LinkIcon /> Share a Skill Set
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="divide-y border-y">
          {packs.map((pack) => (
            <PackRow key={pack.packId} pack={pack} onRevoke={setPendingRevoke} />
          ))}
        </div>
      )}

      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          Pack links carry access by possession. Account and device tokens stay on the
          creator&apos;s machine and are never placed in the shared URL.
        </p>
      </div>

      <Dialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRevoke(null);
            setRevokeError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke {pendingRevoke?.name}?</DialogTitle>
            <DialogDescription>
              The public preview and import will stop working immediately. Existing local imports
              are not removed.
            </DialogDescription>
          </DialogHeader>
          {revokeError ? <p className="text-sm text-destructive">{revokeError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRevoke(null)}>
              Keep active
            </Button>
            <Button
              variant="destructive"
              disabled={!pendingRevoke || revoke?.access !== "available" || revoke.isPending}
              onClick={() => {
                if (!pendingRevoke || revoke?.access !== "available") return;
                setRevokeError(null);
                void revoke.execute(pendingRevoke.packId).then(
                  () => {
                    toast.success("Pack revoked");
                    setPendingRevoke(null);
                    return query.refresh();
                  },
                  (cause: unknown) =>
                    setRevokeError(
                      cause instanceof Error ? cause.message : "The Pack could not be revoked.",
                    ),
                );
              }}
            >
              <BanIcon />{" "}
              {revoke?.access === "available" && revoke.isPending ? "Revoking" : "Revoke Pack"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

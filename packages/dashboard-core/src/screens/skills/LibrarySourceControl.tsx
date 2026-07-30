import { ExternalLinkIcon, FolderOpenIcon, GithubIcon } from "lucide-react";

import type { DashboardLibraryActions } from "../../host";
import type { LibrarySourceModel } from "../../models";
import { Button } from "@selftune/ui/primitives";

export function LibrarySourceControl({
  source,
  actions,
  onError,
}: {
  source: LibrarySourceModel;
  actions: DashboardLibraryActions;
  onError(message: string): void;
}) {
  const openLocation = actions.openLocation;
  if (source.href) {
    return (
      <Button
        nativeButton={false}
        render={<a href={source.href} target="_blank" rel="noreferrer" />}
        variant="ghost"
        size="xs"
        className="max-w-52"
        title={source.href}
      >
        {source.kind === "github" ? <GithubIcon data-icon="inline-start" /> : null}
        <span className="truncate">{source.label}</span>
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
    );
  }
  if (source.path && openLocation.access === "available") {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="max-w-52"
        title={source.path}
        onClick={() => {
          void openLocation.execute(source.path ?? "").catch((error: unknown) => {
            onError(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        <span className="truncate">{source.label}</span>
        <FolderOpenIcon data-icon="inline-end" />
      </Button>
    );
  }
  return <span className="truncate text-xs text-muted-foreground">{source.label}</span>;
}

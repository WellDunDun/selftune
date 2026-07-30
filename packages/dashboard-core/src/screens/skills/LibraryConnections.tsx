import type { LibrarySkillModel } from "../../models";
import { cn } from "@selftune/ui/lib";
import { Badge } from "@selftune/ui/primitives";

export function LibraryConnections({ skill }: { skill: LibrarySkillModel }) {
  const byConnection = new Map<string, LibrarySkillModel["locations"][number]>();
  for (const location of skill.locations) {
    if (location.connection) byConnection.set(location.connection, location);
  }
  const connections = [...byConnection.values()];
  if (connections.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-1.5">
      {connections.map((location) =>
        location.connectionIcon ? (
          <span
            key={location.connection}
            className="inline-flex size-7 items-center justify-center overflow-hidden rounded-md border bg-background"
            title={location.connection ?? undefined}
          >
            <span
              role="img"
              aria-label={location.connection ?? "Connection"}
              className={cn(
                "bg-center bg-no-repeat",
                location.connectionIcon.inset === "sm" ? "size-5" : "size-full",
                location.connectionIcon.invert_in_dark && "dark:invert",
              )}
              style={{
                backgroundImage: `url("${location.connectionIcon.src}")`,
                backgroundSize: location.connectionIcon.fit,
              }}
            />
          </span>
        ) : (
          <Badge key={location.connection} variant="secondary">
            {location.connection}
          </Badge>
        ),
      )}
    </div>
  );
}

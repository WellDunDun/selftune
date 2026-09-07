import type { LibrarySkillModel } from "../../models";
import { contextFootprint } from "./context-footprint";
import { HarnessLabel } from "@selftune/ui/components";

export function ContextSavings({
  skills,
  selectedIds,
}: {
  skills: readonly LibrarySkillModel[];
  selectedIds?: ReadonlySet<string>;
}) {
  const rows = contextFootprint(skills, selectedIds);
  const baseline = new Map(contextFootprint(skills).map((row) => [row.key, row]));
  const preview = selectedIds !== undefined;
  return (
    <section aria-label="Context savings by harness" className="space-y-3">
      <h3 className="text-sm font-medium">
        {preview ? "Estimated tokens freed per session" : "Context savings by harness"}
      </h3>
      <p className="text-xs text-muted-foreground">
        Estimated discovery tokens per new session. Full instructions are excluded.
      </p>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="w-2/5 py-2">Harness / scope</th>
                {preview ? <th className="px-1 text-right">Now</th> : null}
                <th className="px-1 text-right">{preview ? "After" : "In use"}</th>
                <th className="text-right">{preview ? "Freed" : "Avoided"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b">
                  <td className="py-2">
                    <HarnessLabel
                      name={row.harness}
                      variant="inline"
                      icon={
                        skills
                          .flatMap((skill) => skill.locations)
                          .find(
                            (location) =>
                              location.connection === row.harness && location.connectionIcon,
                          )?.connectionIcon
                      }
                    />
                    <span className="block truncate text-muted-foreground" title={row.scope}>
                      {row.scope.split("/").filter(Boolean).at(-1) ?? row.scope}
                    </span>
                  </td>
                  {preview ? (
                    <td className="px-1 text-right tabular-nums">
                      {row.unknown
                        ? "Unknown"
                        : `~${baseline.get(row.key)?.current.toLocaleString("en") ?? 0}`}
                    </td>
                  ) : null}
                  <td className="px-1 text-right tabular-nums">
                    {row.unknown ? "Unknown" : `~${row.current.toLocaleString("en")}`}
                  </td>
                  <td className="text-right font-semibold tabular-nums">
                    {row.unknown
                      ? "Unknown"
                      : `~${(preview ? Math.max(0, (baseline.get(row.key)?.current ?? 0) - row.current) : row.savings).toLocaleString("en")}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No installed or previously moved skill metadata available.
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">How this is calculated</summary>
        <p className="mt-2 leading-5">
          Names and descriptions, plus paths for Codex and Pi, at four bytes per token. Claude and
          Pi manual-only skills count as zero. Host budgets, disabled skills, shared search paths
          and model tokenizers can reduce actual savings. Project rows are separate contexts, not
          additive. Measured prompt savings are unavailable until the harness exposes comparable
          before/after prompts. Existing conversations do not shrink.
        </p>
      </details>
    </section>
  );
}

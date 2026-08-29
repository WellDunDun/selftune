"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardCorrectionStudiesContribution } from "../../host";
import { isDecisionReady, type CorrectionStudyReviewModel } from "../../models";
import { Badge, Button, Input } from "@selftune/ui/primitives";

export function CorrectionStudyReviewPanel({
  contribution,
}: {
  readonly contribution: DashboardCorrectionStudiesContribution | undefined;
}) {
  const [items, setItems] = useState<readonly CorrectionStudyReviewModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!contribution || contribution.access !== "available") return;
    setLoading(true);
    try {
      setItems((await contribution.list()).filter(isDecisionReady));
      setError(null);
    } catch {
      setError("Correction reviews could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [contribution]);
  useEffect(() => void refresh(), [refresh]);
  if (!contribution) return null;
  // The Skills page is a library, not a queue. With nothing decidable and
  // nothing broken there is no panel at all, rather than an empty one.
  if (contribution.access === "available" && items.length === 0 && !error) return null;
  if (contribution.access !== "available") {
    return (
      <p className="text-sm text-muted-foreground">
        Correction review:{" "}
        {contribution.access === "upgrade" ? "Upgrade required on this host." : contribution.reason}
      </p>
    );
  }
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Correction reviews">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Correction reviews</h2>
          <p className="text-sm text-muted-foreground">
            Observed feedback is review-only. Decisions never apply a skill.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || pending !== null}
          onClick={refresh}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {items.map((item) => (
        <article key={item.candidateId} className="space-y-2 rounded-md border p-3">
          <div className="flex gap-2">
            <Badge variant="secondary">{item.evidenceLevel}</Badge>
            <span className="text-sm">{item.observedFailure}</span>
          </div>
          <p className="text-sm">{item.correctionIntent}</p>
          {item.proposedChange ? (
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
              {item.proposedChange.diff ?? item.proposedChange.summary}
            </pre>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {item.evaluation?.summary ?? "No replay or evaluation result is available."}
          </p>
          {item.evaluation?.regressions.length ? (
            <p className="text-xs text-destructive">
              Regressions: {item.evaluation.regressions.join(", ")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Limitations: {item.limitations.join(" ")} Provenance: {item.provenance.join("; ")}
          </p>
          <Input
            aria-label={`Reason for ${item.candidateId}`}
            value={reason[item.candidateId] ?? ""}
            onChange={(event) => setReason({ ...reason, [item.candidateId]: event.target.value })}
            placeholder="Reason for this decision"
          />
          <div className="flex flex-wrap gap-2">
            {(["accept", "reject", "defer"] as const).map((action) => (
              <Button
                key={action}
                size="sm"
                disabled={
                  pending !== null ||
                  !item.actions[action].available ||
                  !(reason[item.candidateId] ?? "").trim() ||
                  (reason[item.candidateId] ?? "").length > 512
                }
                title={item.actions[action].reason}
                onClick={async () => {
                  try {
                    setPending(item.candidateId);
                    await contribution.recordDecision({
                      candidateId: item.candidateId,
                      action,
                      reason: reason[item.candidateId]!,
                      manifestDigest: item.manifestDigest,
                    });
                    setReason({ ...reason, [item.candidateId]: "" });
                    await refresh();
                  } catch {
                    setError("The decision could not be recorded.");
                  } finally {
                    setPending(null);
                  }
                }}
              >
                {pending === item.candidateId ? "Saving…" : action}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled
              title={item.actions.edit.reason ?? "Editing requires a replacement candidate."}
            >
              Edit unavailable
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}

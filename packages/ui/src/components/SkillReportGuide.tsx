import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../primitives";

const SKILL_REPORT_ONBOARDING_KEY = "selftune.skill-report-onboarding-dismissed";

/* ─── Guide Sheet (slide-over panel) ──────────────────── */

export function SkillReportGuideSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity"
        onClick={() => onOpenChange(false)}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative z-10 w-full max-w-lg overflow-y-auto bg-white shadow-xl dark:bg-slate-900 animate-in slide-in-from-right duration-200"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              How to read this page
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              selftune earns trust by showing what it observed, what it proposed, how it tested the
              change, and what happened next.
            </p>
          </div>
          <Button
            variant="ghost"
            className="shrink-0 rounded-full p-1.5"
            onClick={() => onOpenChange(false)}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="space-y-8 px-6 py-6">
          {/* The improvement loop */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
              The improvement loop
            </h3>
            <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
              <p>
                <strong className="text-slate-900 dark:text-white">1. Observe.</strong> selftune
                watches real sessions and notes when a skill triggered, missed, or looked noisy.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">2. Propose.</strong> When the
                signal is strong enough, it suggests a wording change to the skill.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">3. Validate.</strong> It checks
                whether the new wording improves routing without breaking important cases.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">4. Decide.</strong> Only
                validated winners should be deployed. Rejected or pending proposals do not change
                the live skill.
              </p>
            </div>
          </section>

          {/* What each section means */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
              What each section means
            </h3>
            <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
              <p>
                <strong className="text-slate-900 dark:text-white">Next Best Action</strong> tells
                you whether you should review, deploy, or simply keep observing.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">
                  How selftune is improving this skill
                </strong>{" "}
                explains the current state in plain language.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">Trust Signals</strong> are the
                condensed metrics behind that story: coverage, evidence quality, routing quality,
                and evolution state.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">Evidence</strong> shows what
                changed and why a proposal was accepted, rejected, or left pending.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">Invocations</strong> shows real
                prompts where this skill triggered or likely should have triggered.
              </p>
              <p>
                <strong className="text-slate-900 dark:text-white">Community</strong> surfaces
                aggregated contributor signals and usage patterns from the broader selftune
                community.
              </p>
            </div>
          </section>

          {/* FAQ */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
              FAQ
            </h3>
            <div className="space-y-4 text-sm text-slate-600 dark:text-slate-400">
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  What is a missed trigger?
                </p>
                <p>
                  A case where selftune believes the skill should have been used, but the agent did
                  not invoke it.
                </p>
              </div>
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  Why was a proposal rejected?
                </p>
                <p>
                  Usually because validation showed the new wording would regress existing behavior,
                  or because it violated a hard rule like dropping an important anchor phrase.
                </p>
              </div>
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  When should I trust a recommendation?
                </p>
                <p>
                  Trust it more when the page shows broad coverage, prompt-linked evidence, and a
                  validated result. Trust it less when the sample is tiny or the data is noisy.
                </p>
              </div>
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  Do I need to understand every metric?
                </p>
                <p>
                  No. Start with the plain-English summary and next best action. Use the deeper tabs
                  only when you want to inspect the evidence yourself.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ─── Onboarding banner (dismissible) ─────────────────── */

export function SkillReportOnboardingBanner({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined"
      ? window.localStorage.getItem(SKILL_REPORT_ONBOARDING_KEY) === "1"
      : false,
  );

  if (dismissed) return null;

  const handleDismiss = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SKILL_REPORT_ONBOARDING_KEY, "1");
    }
    setDismissed(true);
  };

  return (
    <div className="rounded-lg border border-blue-200/40 bg-blue-50/50 px-4 py-3 dark:border-blue-900/40 dark:bg-blue-950/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600 dark:text-slate-400">
          <span className="font-medium text-slate-900 dark:text-white">New to selftune?</span> Start
          with the summary below, then open the guide if you want the full improvement loop
          explained step by step.
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onOpenGuide}>
            Open guide
          </Button>
          <Button variant="ghost" onClick={handleDismiss}>
            Hide
          </Button>
        </div>
      </div>
    </div>
  );
}

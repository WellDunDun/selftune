"use client";

import { useState } from "react";
import {
  ArrowRightIcon,
  GitPullRequestArrowIcon,
  ListChecksIcon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";

export interface OverviewOnboardingBannerProps {
  skillCount: number;
  cloudSourceCount?: number | null;
  storageKey?: string;
}

const cloudLaunchStages = [
  {
    icon: WaypointsIcon,
    step: "01",
    title: "Create a real source",
    description:
      "Link GitHub or upload a draft so the hosted loop works from an actual cloud snapshot.",
  },
  {
    icon: ListChecksIcon,
    step: "02",
    title: "Shape reviewable evals",
    description:
      "Seed a quick suite, edit the trigger rows, and keep the first hosted slice explicit and trustworthy.",
  },
  {
    icon: GitPullRequestArrowIcon,
    step: "03",
    title: "Review before apply",
    description:
      "Run the paired compare, inspect proposal evidence, and only advance the draft when the winner is credible.",
  },
] as const;

const localLaunchStages = [
  {
    icon: WaypointsIcon,
    step: "01",
    title: "Open your skill library",
    description: "Start with the local skill inventory so you can see what is wired and missing.",
  },
  {
    icon: ListChecksIcon,
    step: "02",
    title: "Inspect real performance",
    description:
      "Use analytics and recent runs to find under-triggering, regressions, and weak spots.",
  },
  {
    icon: GitPullRequestArrowIcon,
    step: "03",
    title: "Evolve deliberately",
    description:
      "Treat the local dashboard as an evidence surface before you change routing or skill body.",
  },
] as const;

export function OverviewOnboardingBanner({
  skillCount,
  cloudSourceCount,
  storageKey = "selftune-onboarding-dismissed",
}: OverviewOnboardingBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });

  const isCloudContext = cloudSourceCount != null;
  const emptyStateCount = isCloudContext ? cloudSourceCount : skillCount;
  if (emptyStateCount > 0 || dismissed) return null;

  const ctas = isCloudContext
    ? [
        {
          href: "/skills",
          label: "Open Cloud Library",
          tone: "primary" as const,
        },
        {
          href: "/observed",
          label: "Import from Observed",
          tone: "secondary" as const,
        },
        {
          href: "/improve",
          label: "See hosted runs",
          tone: "text" as const,
        },
      ]
    : [
        {
          href: "/skills",
          label: "Open Skill Library",
          tone: "primary" as const,
        },
        {
          href: "/analytics",
          label: "View Analytics",
          tone: "secondary" as const,
        },
      ];

  const highlightCards = isCloudContext
    ? [
        {
          label: "Source-backed",
          body: "GitHub-backed and upload flows feed the same cloud draft model.",
        },
        {
          label: "Reviewable evals",
          body: "Quick suites stay explicit, editable, and aligned to the hosted runner.",
        },
        {
          label: "Draft apply",
          body: "The goal is a trusted review queue, not blind autonomous mutation.",
        },
      ]
    : [
        {
          label: "Local evidence",
          body: "The local dashboard should help you spot skill drift before you reach for edits.",
        },
        {
          label: "Watch behavior",
          body: "Analytics and recent runs tell you where routing and execution are actually weak.",
        },
        {
          label: "Deliberate changes",
          body: "Use the local loop to understand the problem before you evolve the skill itself.",
        },
      ];

  const stages = isCloudContext ? cloudLaunchStages : localLaunchStages;

  const dismiss = () => {
    setDismissed(true);
    try {
      globalThis.localStorage?.setItem(storageKey, "true");
    } catch {
      // ignore local storage failures
    }
  };

  return (
    <section className="col-span-12 overflow-hidden rounded-[28px] border border-primary/15 bg-[radial-gradient(circle_at_top_left,rgba(79,242,255,0.2),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(0,213,227,0.14),transparent_28%),linear-gradient(180deg,rgba(8,16,27,0.98),rgba(7,12,22,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <div className="pointer-events-none absolute -left-16 top-6 size-44 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute right-0 top-10 size-40 rounded-full bg-primary/8 blur-3xl" />

        <button
          type="button"
          onClick={dismiss}
          aria-label={
            isCloudContext
              ? "Dismiss hosted cloud loop guidance"
              : "Dismiss local dashboard guidance"
          }
          className="absolute right-4 top-4 z-10 inline-flex size-8 items-center justify-center rounded-full border border-border/60 bg-background/30 text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>

        <div className="grid gap-8 p-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)] lg:p-8">
          <div className="relative z-10 flex flex-col gap-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 font-headline text-[10px] uppercase tracking-[0.22em] text-primary">
              {isCloudContext ? "Hosted Cloud Loop" : "Local Dashboard"}
            </div>

            <div className="space-y-4">
              <h2 className="max-w-3xl font-headline text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                {isCloudContext
                  ? "Move from raw skill files to reviewable cloud proposals."
                  : "Use the local dashboard to understand a skill before you change it."}
              </h2>
              <p className="max-w-2xl text-sm leading-7 text-muted-foreground sm:text-[15px]">
                {isCloudContext
                  ? "SelfTune Cloud is now centered on a real hosted improvement loop: source-backed drafts, explicit eval suites, paired runs, and proposal review before draft apply."
                  : "The local dashboard is your evidence surface: inventory, analytics, and recent runs that help you see what a skill is actually doing before you evolve it."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {ctas.map((cta) => {
                if (cta.tone === "primary") {
                  return (
                    <a
                      key={cta.href}
                      href={cta.href}
                      className="inline-flex items-center gap-2 rounded-xl border border-primary/35 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_14px_30px_rgba(79,242,255,0.18)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_36px_rgba(79,242,255,0.24)]"
                    >
                      {cta.label}
                      <ArrowRightIcon className="size-4" />
                    </a>
                  );
                }

                if (cta.tone === "secondary") {
                  return (
                    <a
                      key={cta.href}
                      href={cta.href}
                      className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-background/55 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/20 hover:bg-background/70"
                    >
                      {cta.label}
                    </a>
                  );
                }

                return (
                  <a
                    key={cta.href}
                    href={cta.href}
                    className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {cta.label}
                  </a>
                );
              })}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {highlightCards.map((card) => (
                <div
                  key={card.label}
                  className="rounded-2xl border border-border/60 bg-background/40 p-4 backdrop-blur-sm"
                >
                  <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {card.label}
                  </p>
                  <p className="mt-2 text-sm font-medium text-foreground">{card.body}</p>
                </div>
              ))}
            </div>
          </div>

          <aside className="relative z-10 rounded-[24px] border border-border/60 bg-background/42 p-5 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-headline text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {isCloudContext ? "First Real Slice" : "Local First Steps"}
                </p>
                <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                  {isCloudContext
                    ? "What the new cloud product should help you do next"
                    : "What the local dashboard should help you do next"}
                </h3>
              </div>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 font-headline text-[10px] uppercase tracking-[0.18em] text-primary">
                {isCloudContext ? "Trust First" : "Evidence First"}
              </span>
            </div>

            <div className="mt-5 space-y-3">
              {stages.map((stage) => {
                const Icon = stage.icon;

                return (
                  <div
                    key={stage.step}
                    className="rounded-2xl border border-border/60 bg-background/55 p-4 transition-colors hover:border-primary/20"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-[0_0_18px_rgba(79,242,255,0.12)]">
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-headline text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                          Step {stage.step}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-foreground">{stage.title}</p>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {stage.description}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-5 text-xs leading-6 text-muted-foreground">
              {isCloudContext
                ? "Start in Cloud Library, bring in a real source, then let the overview hand off into runs and proposal review instead of generic telemetry onboarding."
                : "Start in your local skill library, inspect analytics, and use the dashboard to understand the problem before you edit a skill."}
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  HeartPulseIcon,
  LibraryIcon,
  SearchIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ON_DEMAND_SKILL_PROMPT } from "@selftune/dashboard-core/screens/skills";

import { Button } from "@/components/ui/button";
import { HarnessLogo } from "@/components/HarnessLogo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useApplyOnboarding } from "@/hooks/useSettings";
import type {
  ApplyOnboardingRequest,
  DesktopSettingsResponse,
  HarnessId,
  OnboardingFeatureId,
} from "@/types";

type HookHarnessId = Exclude<HarnessId, "openclaw">;

const STEPS = [
  "Connect agent",
  "Import history",
  "Install hooks",
  "Choose features",
  "Use on demand",
] as const;

const AGENT_SETUP_PROMPT = `Connect this AI agent to the SelfTune Mac app.

First inspect the current agent harness and installed skills. If the SelfTune skill is not already installed, install it from selftune-dev/selftune using the standard agent-skills installer. Verify the installed skill can be discovered by this harness and report its installation path.

Keep the setup local. Do not install hooks, import session history, enable a background service, connect a cloud account, upload data, publish a skill, change credentials, or modify an existing skill. Those choices will be handled separately in the SelfTune app.

If this harness loads skills only at startup, tell me to start a new session after installation.`;

const FEATURES: Array<{
  id: OnboardingFeatureId;
  label: string;
  description: string;
  recommendation?: string;
  icon: typeof DatabaseIcon;
}> = [
  {
    id: "observability",
    label: "Skill observability",
    description: "Collect selected session history every 30 minutes.",
    recommendation: "Recommended",
    icon: DatabaseIcon,
  },
  {
    id: "health_recommendations",
    label: "Health recommendations",
    description: "Evaluate skill health and surface daily recommendations.",
    recommendation: "Recommended",
    icon: HeartPulseIcon,
  },
  {
    id: "autonomous_improvement",
    label: "Autonomous improvement",
    description: "Run validated local improvement cycles every two hours.",
    icon: SparklesIcon,
  },
];

function selectionFromSettings(settings: DesktopSettingsResponse) {
  const imports = { ...settings.onboarding.import_sources };
  const hooks = { ...settings.onboarding.hook_harnesses };
  if (!settings.onboarding.completed) {
    for (const harness of settings.harnesses) {
      imports[harness.id] = harness.detected || harness.import_available;
      if (harness.id !== "openclaw") hooks[harness.id] = harness.hooks_installed;
    }
  }
  return { imports, hooks, features: { ...settings.onboarding.features } };
}

export function SetupWizard({ settings }: { settings: DesktopSettingsResponse }) {
  const initial = useMemo(() => selectionFromSettings(settings), [settings]);
  const applySetup = useApplyOnboarding();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [imports, setImports] = useState(initial.imports);
  const [hooks, setHooks] = useState(initial.hooks);
  const [features, setFeatures] = useState(initial.features);

  useEffect(() => {
    if (!settings.onboarding.completed) setOpen(true);
  }, [settings.onboarding.completed]);

  function resetDraft() {
    const next = selectionFromSettings(settings);
    setImports(next.imports);
    setHooks(next.hooks);
    setFeatures(next.features);
    setStep(0);
  }

  function apply() {
    const request: ApplyOnboardingRequest = {
      import_sources: settings.harnesses
        .filter((harness) => imports[harness.id])
        .map((harness) => harness.id),
      hook_harnesses: settings.harnesses
        .filter(
          (harness): harness is typeof harness & { id: HookHarnessId } =>
            harness.id !== "openclaw" && hooks[harness.id],
        )
        .map((harness) => harness.id),
      features,
    };
    applySetup.mutate(request, {
      onSuccess: (result) => {
        const failures = result.install_results.filter((entry) => entry.status === "failed");
        if (result.source_sync.status === "failed") {
          toast.warning("Setup saved, but history processing failed", {
            description:
              result.source_sync.message ??
              "SelfTune will retry from the selected sources on the next scheduled sync.",
          });
        } else if (failures.length > 0) {
          toast.warning("Setup saved with hook issues", {
            description: failures.map((entry) => entry.message).join(" "),
          });
        } else {
          toast.success("SelfTune setup complete", {
            description:
              result.source_sync.status === "processed"
                ? "Session history is processed. Review your cleanup recommendations next."
                : "Your selected history is current. Review your cleanup recommendations next.",
          });
        }
        setOpen(false);
        navigate("/skills", { replace: true });
      },
      onError: (error) =>
        toast.error("Setup failed", {
          description: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  async function copyAgentPrompt() {
    try {
      await navigator.clipboard.writeText(AGENT_SETUP_PROMPT);
      toast.success("Agent setup prompt copied");
    } catch {
      toast.error("Could not copy the agent setup prompt");
    }
  }

  async function copyOnDemandPrompt() {
    try {
      await navigator.clipboard.writeText(ON_DEMAND_SKILL_PROMPT);
      toast.success("Example request copied");
    } catch {
      toast.error("Could not copy the example request");
    }
  }

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          resetDraft();
          setOpen(true);
        }}
      >
        <WandSparklesIcon /> Configure SelfTune
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-[680px]">
          <DialogHeader className="border-b border-border/70 px-6 py-5 pr-14">
            <DialogTitle>Set up SelfTune</DialogTitle>
            <DialogDescription>
              Choose where evidence comes from, where live hooks run, and how far SelfTune can act.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center border-b border-border/70 px-6 py-3">
            {STEPS.map((label, index) => (
              <div key={label} className="flex min-w-0 flex-1 items-center last:flex-none">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
                      index <= step
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {index < step ? <CheckIcon className="size-3" /> : index + 1}
                  </span>
                  <span
                    className={
                      index === step ? "text-xs text-foreground" : "text-xs text-muted-foreground"
                    }
                  >
                    {label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <span className="mx-3 h-px min-w-5 flex-1 bg-border" />
                )}
              </div>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {step === 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Connect your AI agent</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Give your agent the SelfTune skill so you can operate the app conversationally.
                </p>
                <div className="mt-4 rounded-lg border border-border/70 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
                      <BotIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          SelfTune agent skill
                        </span>
                        <span
                          className={`text-[11px] font-normal ${
                            settings.agent_skill.installed
                              ? "text-primary"
                              : "text-muted-foreground"
                          }`}
                        >
                          {settings.agent_skill.installed ? "Installed" : "Not detected"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {settings.agent_skill.installed
                          ? `Found in ${settings.agent_skill.locations.length} agent skill location${settings.agent_skill.locations.length === 1 ? "" : "s"}.`
                          : "Ask your agent to install and verify the skill before continuing."}
                      </p>
                    </div>
                  </div>
                  {!settings.agent_skill.installed && (
                    <div className="mt-4 space-y-3">
                      <Button className="w-full" onClick={copyAgentPrompt}>
                        <CopyIcon /> Copy prompt for my AI agent
                      </Button>
                      <div>
                        <p className="text-xs text-muted-foreground">Manual fallback</p>
                        <code className="mt-1 block overflow-x-auto rounded-md bg-muted/50 px-3 py-2 text-xs text-foreground">
                          {settings.agent_skill.install_command}
                        </code>
                      </div>
                    </div>
                  )}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Some agents discover newly installed skills only after starting a new session.
                </p>
              </div>
            )}

            {step === 1 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Import session history</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Selected sources contribute evidence to skill health and improvement decisions.
                </p>
                <div className="mt-4 overflow-hidden rounded-lg border border-border/70">
                  {settings.harnesses.map((harness) => {
                    const available = harness.detected || harness.import_available;
                    return (
                      <label
                        key={harness.id}
                        className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
                      >
                        <HarnessLogo name={harness.name} icon={harness.icon} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">
                            {harness.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {available ? "Session source found" : "Not found on this computer"}
                          </span>
                        </span>
                        <Switch
                          checked={imports[harness.id]}
                          disabled={!available}
                          aria-label={`Import ${harness.name} history`}
                          onCheckedChange={(checked) =>
                            setImports((current) => ({
                              ...current,
                              [harness.id]: checked,
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Install live hooks</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Hooks capture prompts, invocations, edits, and session outcomes as they happen.
                </p>
                <div className="mt-4 overflow-hidden rounded-lg border border-border/70">
                  {settings.harnesses.map((harness) => {
                    if (!harness.hooks_supported || harness.id === "openclaw") return null;
                    return (
                      <label
                        key={harness.id}
                        className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
                      >
                        <HarnessLogo name={harness.name} icon={harness.icon} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {harness.name}
                            {harness.hooks_installed && (
                              <span className="text-[11px] font-normal text-primary">
                                Installed
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {harness.detected
                              ? "Live integration available"
                              : "Connection not found"}
                          </span>
                        </span>
                        <Switch
                          checked={hooks[harness.id]}
                          disabled={!harness.detected || harness.hooks_installed}
                          aria-label={`Install ${harness.name} hooks`}
                          onCheckedChange={(checked) =>
                            setHooks((current) => ({
                              ...current,
                              [harness.id]: checked,
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Existing hooks are preserved. SelfTune only adds or updates its own entries.
                </p>
              </div>
            )}

            {step === 3 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Choose operating mode</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start with measurement, then enable autonomous changes when the evidence is
                  useful.
                </p>
                <div className="mt-4 overflow-hidden rounded-lg border border-border/70">
                  {FEATURES.map((feature) => {
                    const Icon = feature.icon;
                    return (
                      <label
                        key={feature.id}
                        className="flex items-center gap-3 border-b border-border/60 px-4 py-4 last:border-b-0"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            {feature.label}
                            {feature.recommendation && (
                              <span className="text-[11px] font-normal text-primary">
                                {feature.recommendation}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {feature.description}
                          </span>
                        </span>
                        <Switch
                          checked={features[feature.id]}
                          aria-label={`Enable ${feature.label}`}
                          onCheckedChange={(checked) =>
                            setFeatures((current) => ({
                              ...current,
                              [feature.id]: checked,
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {step === 4 && (
              <div>
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <LibraryIcon className="size-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      Keep specialist skills ready, not always loaded
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      SelfTune can find a local skill or collection, make it available to this
                      project for one task, and remove only the links that task created.
                    </p>
                  </div>
                </div>

                <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <SearchIcon className="size-3.5" /> Try this with your agent
                  </div>
                  <p className="mt-3 font-mono text-xs leading-5 text-foreground">
                    {ON_DEMAND_SKILL_PROMPT}
                  </p>
                  <Button className="mt-4 w-full" onClick={copyOnDemandPrompt}>
                    <CopyIcon /> Copy example request
                  </Button>
                </div>

                <p className="mt-4 text-xs leading-5 text-muted-foreground">
                  After setup, review usage-based suggestions in the Skills Library. Select the
                  skills you need occasionally, review context savings by harness, and choose Keep
                  selected on demand. You can undo the move or activate them for a task later.
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="m-0 shrink-0 rounded-none px-6 py-4">
            {step > 0 && (
              <Button
                variant="outline"
                disabled={applySetup.isPending}
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeftIcon /> Back
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep(step + 1)}>
                Continue <ArrowRightIcon />
              </Button>
            ) : (
              <Button disabled={applySetup.isPending} onClick={apply}>
                <CheckIcon /> {applySetup.isPending ? "Processing history" : "Apply setup"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { ExternalLinkIcon, LogInIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCloudBillingCheckout,
  useCloudBillingPortal,
  useCloudBillingStatus,
} from "@/hooks/useSettings";

export interface BillingSettingsPanelProps {
  readonly cloudConfigured: boolean;
  readonly active: boolean;
  readonly connectPending: boolean;
  readonly onConnect: () => void;
  readonly openExternal?: (url: string) => void | Promise<void>;
}

function planName(id: "free" | "pro" | "team" | "enterprise"): string {
  if (id === "free") return "Community";
  if (id === "enterprise") return "Enterprise";
  return id === "pro" ? "Pro" : "Team";
}

/** Desktop's Settings tab for the Cloud-owned billing journey. */
export function BillingSettingsPanel({
  cloudConfigured,
  active,
  connectPending,
  onConnect,
  openExternal,
}: BillingSettingsPanelProps) {
  const cloudBilling = useCloudBillingStatus(cloudConfigured && active);
  const cloudBillingCheckout = useCloudBillingCheckout();
  const cloudBillingPortal = useCloudBillingPortal();
  const [teamSeats, setTeamSeats] = useState(1);

  async function openBillingUrl(url: string) {
    if (openExternal) {
      await openExternal(url);
      return;
    }
    if (window.selftuneDesktop) {
      await window.selftuneDesktop.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function startCheckout(plan: "pro" | "team", seats?: number) {
    cloudBillingCheckout.mutate(seats === undefined ? { plan } : { plan, seats }, {
      onSuccess: ({ url }) => void openBillingUrl(url),
      onError: (error) =>
        toast.error("Checkout could not be started", {
          description: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  function openBillingPortal() {
    cloudBillingPortal.mutate(undefined, {
      onSuccess: ({ url }) => void openBillingUrl(url),
      onError: (error) =>
        toast.error("Billing portal could not be opened", {
          description: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  return (
    <section aria-labelledby="billing-heading">
      <div className="mb-3">
        <h2 id="billing-heading" className="text-base font-semibold text-foreground">
          Billing
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your SelfTune Cloud workspace plan and subscription.
        </p>
      </div>
      {!cloudConfigured ? (
        <div className="rounded-lg border border-border/70 bg-background/25 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Connect SelfTune Cloud</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Link a Cloud account to view your plan and securely manage billing. Your local
                Library remains available without Cloud.
              </p>
            </div>
            <Button size="sm" disabled={connectPending} onClick={onConnect}>
              <LogInIcon data-icon="inline-start" />
              {connectPending ? "Waiting for approval" : "Connect Cloud"}
            </Button>
          </div>
        </div>
      ) : cloudBilling.isLoading ? (
        <div className="rounded-lg border border-border/70 bg-background/25 p-5 text-sm text-muted-foreground">
          Loading billing…
        </div>
      ) : cloudBilling.isError || !cloudBilling.data ? (
        <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-5">
          <p role="alert" className="text-sm text-destructive">
            {cloudBilling.error instanceof Error
              ? cloudBilling.error.message
              : "Billing is unavailable right now."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => cloudBilling.refetch()}
          >
            <RefreshCwIcon data-icon="inline-start" /> Retry
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/70 bg-background/25">
          <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">
                Current plan:{" "}
                {cloudBilling.data.availablePlans.find(
                  (plan) => plan.id === cloudBilling.data?.plan,
                )?.name ?? planName(cloudBilling.data.plan)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {cloudBilling.data.subscriptionStatus === "none"
                  ? "No active subscription"
                  : cloudBilling.data.subscriptionStatus}
              </p>
            </div>
            {cloudBilling.data.plan !== "free" && cloudBilling.data.canManageBilling ? (
              <Button
                variant="outline"
                size="sm"
                disabled={cloudBillingPortal.isPending}
                onClick={openBillingPortal}
              >
                <ExternalLinkIcon data-icon="inline-start" />
                {cloudBillingPortal.isPending ? "Opening" : "Manage subscription"}
              </Button>
            ) : null}
          </div>
          {!cloudBilling.data.canManageBilling ? (
            <p className="border-b border-border/60 px-4 py-3 text-sm text-muted-foreground">
              Only workspace owners can manage billing.
            </p>
          ) : null}
          <div className="grid gap-px bg-border/60 md:grid-cols-2">
            {cloudBilling.data.availablePlans.map((plan) => {
              const current = plan.id === cloudBilling.data?.plan;
              const checkoutPlan = plan.id;
              return (
                <div key={plan.id} className="bg-background px-4 py-4">
                  <p className="text-sm font-medium text-foreground">{plan.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plan.price ? `${plan.price}${plan.period ?? ""}` : "Contact us"}
                  </p>
                  <p className="mt-2 min-h-10 text-xs text-muted-foreground">{plan.description}</p>
                  {checkoutPlan === "team" && !current && cloudBilling.data?.plan === "free" ? (
                    <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                      Seats
                      <Input
                        aria-label="Team seats"
                        className="h-8"
                        type="number"
                        min={plan.seats?.minimum ?? 1}
                        max={1_000}
                        value={teamSeats}
                        onChange={(event) => setTeamSeats(Number(event.target.value))}
                      />
                    </label>
                  ) : null}
                  {checkoutPlan === "pro" || checkoutPlan === "team" ? (
                    <Button
                      variant={current ? "outline" : "default"}
                      size="sm"
                      className="mt-3"
                      disabled={
                        current ||
                        !cloudBilling.data?.canManageBilling ||
                        cloudBillingCheckout.isPending ||
                        cloudBillingPortal.isPending
                      }
                      onClick={() => {
                        if (cloudBilling.data?.plan !== "free") openBillingPortal();
                        else
                          startCheckout(
                            checkoutPlan,
                            checkoutPlan === "team"
                              ? Math.min(
                                  1_000,
                                  Math.max(plan.seats?.minimum ?? 1, Math.trunc(teamSeats) || 1),
                                )
                              : undefined,
                          );
                      }}
                    >
                      {current
                        ? "Current plan"
                        : cloudBilling.data?.plan === "free"
                          ? "Choose plan"
                          : "Manage plan"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

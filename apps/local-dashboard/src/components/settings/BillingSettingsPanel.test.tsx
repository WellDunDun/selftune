// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBillingStatus } from "@/types";

const checkoutMutate = vi.fn();
const portalMutate = vi.fn();
const refetch = vi.fn();
let billingState: {
  isLoading: boolean;
  isError: boolean;
  data: DesktopBillingStatus | undefined;
  error: Error | null;
  refetch: () => void;
};

vi.mock("@/hooks/useSettings", () => ({
  useCloudBillingStatus: () => billingState,
  useCloudBillingCheckout: () => ({ isPending: false, mutate: checkoutMutate }),
  useCloudBillingPortal: () => ({ isPending: false, mutate: portalMutate }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import { BillingSettingsPanel } from "./BillingSettingsPanel";

const plans = [
  {
    id: "pro" as const,
    name: "Pro",
    price: "$10",
    period: "/month",
    description: "For individuals",
    features: [],
    highlighted: false,
  },
  {
    id: "team" as const,
    name: "Team",
    price: "$12",
    period: "/month",
    description: "For teams",
    features: [],
    highlighted: true,
    seats: { minimum: 3, label: "per seat" },
  },
];

function status(overrides: Partial<DesktopBillingStatus> = {}): DesktopBillingStatus {
  return {
    plan: "free",
    subscriptionStatus: "none",
    currentPeriodEnd: null,
    trialEnd: null,
    seatCount: 1,
    hasStripeCustomer: false,
    canManageBilling: true,
    availablePlans: plans,
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof BillingSettingsPanel>> = {}) {
  return render(
    <BillingSettingsPanel
      active
      cloudConfigured
      connectPending={false}
      onConnect={vi.fn()}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  checkoutMutate.mockReset();
  portalMutate.mockReset();
  refetch.mockReset();
  billingState = { isLoading: false, isError: false, data: status(), error: null, refetch };
});

describe("BillingSettingsPanel", () => {
  it("offers Connect Cloud while Desktop is not linked", () => {
    const onConnect = vi.fn();
    renderPanel({ cloudConfigured: false, onConnect });
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloud" }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows the linked workspace plan with Cloud-compatible price formatting", () => {
    renderPanel();
    expect(screen.getByText("Current plan: Community")).not.toBeNull();
    expect(screen.getByText("$12/month")).not.toBeNull();
  });

  it("uses a user-facing Enterprise fallback when Cloud omits that plan", () => {
    billingState = {
      isLoading: false,
      isError: false,
      data: status({ plan: "enterprise", availablePlans: [] }),
      error: null,
      refetch,
    };
    renderPanel();
    expect(screen.getByText("Current plan: Enterprise")).not.toBeNull();
  });

  it("sends the owner-selected Team seat count and opens checkout externally", () => {
    const openExternal = vi.fn();
    checkoutMutate.mockImplementation((input, callbacks) =>
      callbacks.onSuccess({ url: "https://stripe.test" }),
    );
    renderPanel({ openExternal });
    fireEvent.change(screen.getByLabelText("Team seats"), { target: { value: "7" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Choose plan" })[1]!);
    expect(checkoutMutate).toHaveBeenCalledWith({ plan: "team", seats: 7 }, expect.any(Object));
    expect(openExternal).toHaveBeenCalledWith("https://stripe.test");
  });

  it("renders a retryable inline error without disconnecting the local app", () => {
    billingState = {
      isLoading: false,
      isError: true,
      data: undefined,
      error: new Error("Cloud offline"),
      refetch,
    };
    renderPanel();
    expect(screen.getByRole("alert").textContent).toBe("Cloud offline");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

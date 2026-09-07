// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settingsFor } from "../test-fixtures/settings";
import { Settings } from "./Settings";

const clients: QueryClient[] = [];

function renderSettings(url: string, route = "/settings?section=remote-library") {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/v2/settings") return Response.json(settingsFor(url));
    if (
      [
        "/api/v2/settings/remote-library/status",
        "/api/v2/settings/remote-library/shares",
        "/api/v2/settings/workspace/members",
        "/api/v2/settings/workspace/policies",
      ].includes(String(input))
    ) {
      return new Response("Service unavailable", { status: 503 });
    }
    throw new Error(`Unexpected request: ${input}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("Settings remote-library capabilities", () => {
  it("renders a newly available automation job before the draft synchronization effect runs", async () => {
    const url = "https://cloud.selftune.dev";
    renderSettings(url, "/settings?section=automation");
    await screen.findByText("Run local collection and improvement jobs in the background.");
    const settings = settingsFor(url);
    act(() =>
      clients.at(-1)?.setQueryData(["settings"], {
        ...settings,
        schedule: {
          ...settings.schedule,
          jobs: [
            {
              id: "selftune-sync",
              label: "Collect",
              description: "Import local sessions",
              command: "selftune sync",
              default_schedule: "*/30 * * * *",
              schedule: "*/15 * * * *",
              enabled: false,
              active: false,
            },
          ],
        },
      }),
    );
    expect(await screen.findByRole("switch", { name: "Enable Collect" })).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Collect frequency" })).not.toBeNull();
  });

  it("shows backup controls only for self-hosting, even when remote status is unavailable", async () => {
    const cloud = renderSettings("https://cloud.selftune.dev");

    await screen.findByRole("heading", {
      name: "Cloud connection & self-hosted backup",
    });
    expect(screen.queryByTitle("Export complete backup")).toBeNull();
    expect(screen.queryByTitle("Restore into a new local directory")).toBeNull();

    cloud.unmount();
    renderSettings("https://selftune.example.com");

    expect(await screen.findByTitle("Export complete backup")).not.toBeNull();
    expect(screen.getByTitle("Restore into a new local directory")).not.toBeNull();
  });
});

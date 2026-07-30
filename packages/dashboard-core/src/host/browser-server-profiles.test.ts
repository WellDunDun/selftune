import { describe, expect, it } from "vitest";

import {
  consumeServerProfilesHandoff,
  createBrowserServerProfileController,
  decodeServerRuntimeProfile,
  SERVER_PROFILE_CONTRACT_PATH,
} from "./browser-server-profiles";

const capabilities = {
  analytics: true,
  registry: false,
  signals: false,
  proposals: false,
  billing: false,
  teamAdmin: false,
  runtimeStatus: true,
};

describe("browser server profiles", () => {
  it("keeps the built-in SelfTune Cloud profile during multitab reconciliation", () => {
    const controller = createBrowserServerProfileController({
      origin: "https://app.selftune.dev",
      capabilities,
      load: () => "[]",
      persist: () => {},
      clearHostState: () => {},
      navigation: { mode: "same_window", navigate: () => {} },
      fetch: async () => new Response(null, { status: 200 }),
    });

    controller.reconcileExternal("[]");

    expect(controller.snapshot().profiles).toMatchObject([
      { id: "cloud:selftune", kind: "cloud", name: "SelfTune Cloud" },
    ]);
  });

  it("keeps self-host credentials in session memory and classifies authentication failures", async () => {
    let persisted = "";
    const controller = createBrowserServerProfileController({
      origin: "https://app.selftune.dev",
      capabilities,
      load: () => "[]",
      persist: (value) => {
        persisted = value;
      },
      clearHostState: () => {},
      navigation: { mode: "same_window", navigate: () => {} },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const authenticated =
          new Headers(init?.headers).get("Authorization") === "Bearer session-key";
        if (url.pathname === SERVER_PROFILE_CONTRACT_PATH) {
          return authenticated
            ? Response.json({
                schema_version: 1,
                host: "selfhost",
                profile: {
                  id: "selfhost:team",
                  name: "Team",
                  origin: "https://team.example.com",
                  authentication: "cookie",
                },
              })
            : new Response(null, { status: 401 });
        }
        return new Response(null, { status: 404 });
      },
    });

    const profile = await controller.add(
      {
        id: "selfhost:team",
        kind: "selfhost",
        name: "Team",
        origin: "https://team.example.com",
        authentication: { kind: "bearer_session" },
        capabilities,
      },
      "session-key",
    );
    expect(profile.status.state).toBe("ready");
    expect(persisted).not.toContain("session-key");

    const reloaded = createBrowserServerProfileController({
      origin: "https://app.selftune.dev",
      capabilities,
      load: () => persisted,
      persist: () => {},
      clearHostState: () => {},
      navigation: { mode: "same_window", navigate: () => {} },
      fetch: async () => new Response(null, { status: 401 }),
    });
    expect((await reloaded.test("selfhost:team")).status).toMatchObject({
      state: "unauthenticated",
      actionLabel: "Enter API key",
    });
  });

  it("hands Self-host auth to an HttpOnly session before cross-origin navigation", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const navigations: string[] = [];
    const controller = createBrowserServerProfileController({
      origin: "https://app.selftune.dev",
      capabilities,
      load: () => "[]",
      persist: () => {},
      clearHostState: () => {},
      navigation: {
        mode: "same_window",
        navigate: (url) => navigations.push(url),
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get("Authorization");
        requests.push({ url: url.toString(), authorization });
        if (url.pathname === SERVER_PROFILE_CONTRACT_PATH) {
          return Response.json({
            schema_version: 1,
            host: "selfhost",
            profile: {
              id: "selfhost:team",
              name: "Team",
              origin: "https://team.example.com",
              authentication: "cookie",
            },
          });
        }
        return Response.json({ handoff_path: "/api/auth/session/handoff?ticket=once" });
      },
    });
    const profile = await controller.add(
      {
        id: "selfhost:team",
        kind: "selfhost",
        name: "Team",
        origin: "https://team.example.com",
        authentication: { kind: "bearer_session" },
        capabilities,
      },
      "session-key",
    );

    await controller.select(profile.id);

    expect(requests.some((request) => request.url.includes("/api/auth/session/handoff"))).toBe(
      true,
    );
    expect(requests.every((request) => request.authorization === "Bearer session-key")).toBe(true);
    expect(navigations[0]).toContain("ticket=once");
    expect(new URL(navigations[0] ?? "https://invalid").searchParams.get("return_to")).toContain(
      "selftune_profile_handoff=",
    );
    expect(navigations[0]).not.toContain("session-key");
  });

  it("transfers only validated profile metadata and removes the handoff from the URL", () => {
    const metadata = JSON.stringify([
      {
        id: "selfhost:team",
        kind: "selfhost",
        name: "Team",
        origin: "https://team.example.com",
        authentication: { kind: "bearer_session" },
        capabilities,
        status: { state: "ready" },
        system: false,
      },
    ]);
    const result = consumeServerProfilesHandoff(
      `https://team.example.com/skills?selftune_profile_handoff=${encodeURIComponent(metadata)}&view=all`,
      capabilities,
    );

    expect(result?.serialized).toContain("selfhost:team");
    expect(result?.cleanUrl).toBe("https://team.example.com/skills?view=all");
    expect(result?.serialized).not.toContain("session-key");
  });

  it("decodes the server-provided host contract without hostname inference", () => {
    expect(
      decodeServerRuntimeProfile({
        schema_version: 1,
        host: "selfhost",
        profile: {
          id: "selfhost:team",
          name: "Team server",
          origin: "https://team.example.com",
          authentication: "cookie",
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      host: "selfhost",
      profile: {
        id: "selfhost:team",
        name: "Team server",
        origin: "https://team.example.com",
        authentication: "cookie",
      },
    });
    expect(() =>
      decodeServerRuntimeProfile({
        schema_version: 1,
        host: "local",
        profile: {
          id: "selfhost:spoofed",
          name: "Spoofed",
          origin: "https://team.example.com",
          authentication: "cookie",
        },
      }),
    ).toThrow();
  });
});

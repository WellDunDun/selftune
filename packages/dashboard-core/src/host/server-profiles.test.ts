import { describe, expect, it } from "vitest";

import {
  createManagedServerProfile,
  createThisMacProfile,
  normalizeServerProfiles,
  ProfileMutationError,
  removeServerProfile,
  renameServerProfile,
  serializeManagedServerProfiles,
  createServerProfileController,
} from "./server-profiles";

const capabilities = {
  analytics: true,
  registry: false,
  signals: false,
  proposals: false,
  billing: false,
  teamAdmin: false,
  runtimeStatus: true,
};

describe("server profiles", () => {
  it("keeps one authoritative This Mac profile and rejects persisted shadows", () => {
    const thisMac = createThisMacProfile({ origin: "http://127.0.0.1:3141", capabilities });
    const shadow = { ...thisMac, name: "Fake Mac", origin: "https://attacker.invalid" };
    const selfhost = createManagedServerProfile({
      id: "selfhost:team",
      kind: "selfhost",
      name: "Team server",
      origin: "https://selftune.example.com",
      authentication: { kind: "bearer_session" },
      capabilities,
    });

    expect(normalizeServerProfiles([shadow, selfhost], thisMac)).toEqual([thisMac, selfhost]);
    expect(() => renameServerProfile([thisMac, selfhost], thisMac.id, "Laptop")).toThrow(
      ProfileMutationError,
    );
    expect(() => removeServerProfile([thisMac, selfhost], thisMac.id)).toThrow(
      ProfileMutationError,
    );
  });

  it("activates a profile only when the host navigation actually changes", async () => {
    const cloud = createManagedServerProfile({
      id: "cloud:selftune",
      kind: "cloud",
      name: "SelfTune Cloud",
      origin: "https://app.selftune.dev",
      authentication: { kind: "cookie" },
      capabilities,
    });
    const calls: string[] = [];
    let persisted = "[]";
    const controller = createServerProfileController({
      initialProfiles: [cloud],
      activeProfileId: cloud.id,
      persist: (value) => {
        persisted = value;
      },
      validate: async (profile) => ({ ...profile, status: { state: "ready" } }),
      switchProfile: async (profile) => {
        calls.push(`switch:${profile.origin}`);
        return "activated";
      },
    });

    const selfhost = await controller.add({
      id: "selfhost:team",
      kind: "selfhost",
      name: "Team server",
      origin: "https://selftune.example.com",
      authentication: { kind: "bearer_session" },
      capabilities,
    });
    await controller.select(selfhost.id);
    expect(calls).toEqual(["switch:https://selftune.example.com"]);
    expect(controller.snapshot().activeProfileId).toBe(selfhost.id);
    expect(persisted).not.toContain("This Mac");

    controller.reconcileExternal(JSON.stringify([cloud]));
    expect(controller.snapshot().profiles).toEqual([cloud]);
  });

  it("keeps This Mac active when Desktop opens a remote profile externally", async () => {
    const thisMac = createThisMacProfile({ origin: "http://127.0.0.1:3141", capabilities });
    const cloud = createManagedServerProfile({
      id: "cloud:selftune",
      kind: "cloud",
      name: "SelfTune Cloud",
      origin: "https://app.selftune.dev",
      authentication: { kind: "cookie" },
      capabilities,
    });
    const controller = createServerProfileController({
      initialProfiles: [cloud],
      activeProfileId: thisMac.id,
      thisMac,
      persist: () => {},
      validate: async (profile) => ({ ...profile, status: { state: "ready" } }),
      switchProfile: async () => "opened_external",
    });

    await controller.select(cloud.id);

    expect(controller.snapshot().activeProfileId).toBe(thisMac.id);
  });

  it("serializes only user-managed metadata and never credentials", () => {
    const thisMac = createThisMacProfile({ origin: "http://127.0.0.1:3141", capabilities });
    const cloud = createManagedServerProfile({
      id: "cloud:selftune",
      kind: "cloud",
      name: "SelfTune Cloud",
      origin: "https://app.selftune.dev",
      authentication: { kind: "cookie" },
      capabilities,
    });

    const serialized = serializeManagedServerProfiles([thisMac, cloud]);
    expect(JSON.parse(serialized)).toEqual([cloud]);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("127.0.0.1");
  });
});

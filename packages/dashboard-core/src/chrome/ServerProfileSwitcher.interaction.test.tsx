// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedServerProfile,
  createThisMacProfile,
  type ServerProfileController,
} from "../host/server-profiles";
import type { DashboardCloudProfileConnection } from "./types";
import { ServerProfileSwitcher } from "./ServerProfileSwitcher";

const capabilities = {
  analytics: false,
  registry: false,
  signals: false,
  proposals: false,
  billing: false,
  teamAdmin: false,
  runtimeStatus: false,
};

const thisMac = createThisMacProfile({
  origin: "http://127.0.0.1:4788",
  capabilities,
});

const cloud = createManagedServerProfile({
  id: "cloud:selftune",
  kind: "cloud",
  name: "SelfTune Cloud",
  origin: "https://app.selftune.dev",
  authentication: { kind: "cookie" },
  capabilities,
});

afterEach(cleanup);

describe("Desktop sidebar Cloud account actions", () => {
  it("keeps Cloud management in Desktop and makes hosted navigation explicit", async () => {
    const select = vi.fn(async () => {});
    const snapshot = { profiles: [thisMac, cloud], activeProfileId: thisMac.id };
    const controller: ServerProfileController = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      add: vi.fn(async () => cloud),
      test: vi.fn(async () => cloud),
      select,
      rename: vi.fn(),
      remove: vi.fn(),
      reconcileExternal: vi.fn(),
    };
    const connection: DashboardCloudProfileConnection = {
      state: "linked",
      connect: vi.fn(async () => {}),
      manage: vi.fn(),
      openDashboard: vi.fn(async () => {}),
    };

    render(<ServerProfileSwitcher controller={controller} cloudConnection={connection} />);

    fireEvent.click(screen.getByRole("button", { name: /This Mac/ }));
    fireEvent.click(await screen.findByText("SelfTune Cloud"));

    expect(connection.manage).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /This Mac/ }));
    fireEvent.click(await screen.findByText("Open Cloud dashboard"));

    expect(connection.openDashboard).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });
});

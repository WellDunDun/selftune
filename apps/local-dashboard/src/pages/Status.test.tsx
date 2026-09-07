// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@selftune/runtime/dashboard-contract/health";
import type { DoctorResult } from "@/types";
import { fetchRuntimeHealth } from "@/api";
import { Status } from "./Status";

const health = {
  ok: true,
  service: "selftune-dashboard",
  version: "0.4.20",
  latest_version: "0.4.21",
  update_available: false,
  auto_update_supported: false,
  update_hint: null,
  pid: 123,
  runtime_instance_id: null,
  runtime_owner: null,
  runtime_supervision: null,
  service_installation_nonce: null,
  owner_executable_path: null,
  spa: true,
  v2_data_available: true,
  workspace_root: "/tmp/status-project",
  git_sha: "test-build",
  db_path: "/tmp/status-project/telemetry.db",
  log_dir: "/tmp/status-project/logs",
  config_dir: "/tmp/status-project/config",
  watcher_mode: "wal",
  process_mode: "test",
  host: "localhost",
  port: 7888,
} satisfies HealthResponse;

const doctor = {
  command: "doctor",
  timestamp: "2026-09-06T10:00:00Z",
  healthy: true,
  checks: [{ name: "new_check", path: "", status: "pass", message: "New check succeeded" }],
  summary: { pass: 1, warn: 0, fail: 0, total: 1 },
} satisfies DoctorResult;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <Status />
    </QueryClientProvider>,
  );
  return client;
}

describe("runtime health boundary", () => {
  it("retains a complete response and absent optional SPA fields", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(health));
    await expect(fetchRuntimeHealth()).resolves.toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ method: "GET" }));
  });

  it("retains Desktop identity and optional SPA metadata", async () => {
    const desktop = {
      ...health,
      runtime_owner: "desktop",
      runtime_supervision: "desktop-child",
      runtime_instance_id: "instance",
      service_installation_nonce: "nonce",
      owner_executable_path: "/Applications/SelfTune.app",
      spa_mode: "proxy",
      spa_build_id: null,
      spa_proxy_url: "http://localhost:5199",
    } satisfies HealthResponse;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(desktop));
    await expect(fetchRuntimeHealth()).resolves.toEqual(desktop);
  });

  it.each([
    null,
    {},
    { ...health, update_available: "false" },
    { ...health, auto_update_supported: "true" },
    { ...health, process_mode: "other" },
    { ...health, latest_version: 42 },
    { ...health, version: null },
    { ...health, runtime_owner: "browser" },
    { ...health, spa_mode: "other" },
    { ...health, watcher_mode: "other" },
    { ...health, port: "7888" },
  ])("rejects a malformed successful health response: %j", async (payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    await expect(fetchRuntimeHealth()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects failed HTTP status even when the body matches the health contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(health, { status: 503 }));
    await expect(fetchRuntimeHealth()).rejects.toMatchObject({ status: 503, code: "API_ERROR" });
  });

  it("rejects malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{broken"));
    await expect(fetchRuntimeHealth()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("System Status runtime details", () => {
  it("shows validated update state and keeps unknown doctor checks visible", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      Response.json(url === "/api/health" ? health : doctor),
    );
    renderStatus();
    await screen.findByText("Up to date");
    expect(screen.queryByText("v0.4.21 available")).toBeNull();
    expect(screen.getByText("new_check")).toBeTruthy();
    expect(screen.getByText(health.workspace_root)).toBeTruthy();
  });

  it("does not display unvalidated runtime data", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      Response.json(url === "/api/health" ? { ...health, update_available: "false" } : doctor),
    );
    const client = renderStatus();
    await screen.findByText("new_check");
    await waitFor(() => expect(client.getQueryState(["runtime-health", 0])?.status).toBe("error"));
    expect(screen.queryByText("Active dashboard runtime")).toBeNull();
    expect(screen.queryByText("v0.4.21 available")).toBeNull();
  });

  it("keeps the latest refresh when an earlier request finishes late", async () => {
    const stale = Promise.withResolvers<Response>();
    let healthRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url !== "/api/health") return Response.json(doctor);
      healthRequests += 1;
      if (healthRequests === 1) return stale.promise;
      return Response.json({ ...health, update_available: true, latest_version: "0.4.22" });
    });
    renderStatus();
    await waitFor(() => expect(healthRequests).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("v0.4.22 available");
    await act(async () => {
      stale.resolve(Response.json(health));
      await stale.promise;
    });
    await waitFor(() => expect(screen.getByText("v0.4.22 available")).toBeTruthy());
    expect(screen.queryByText("Up to date")).toBeNull();
  });
});

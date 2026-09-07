import { expect, test } from "bun:test";
import { CatalogSkillResolutionProgress } from "@selftune/runtime/skill-sets/catalog-resolution";
import { DashboardOperationError } from "../src/dashboard-operation-errors.js";
import {
  dashboardOperationErrorResponse,
  sameOriginFailure,
  withDashboardCors,
} from "../src/dashboard-http.js";

const failure = {
  operation: "private operation",
  code: "CATALOG_SKILL_RESOLUTION_FAILED",
  message: "Cannot download skill",
  status: 422,
  retryable: true,
};

test.each([undefined, ""])(
  "omits absent diagnostic fields and suggestion %j",
  async (suggestion) => {
    const response = dashboardOperationErrorResponse(
      DashboardOperationError.make({ ...failure, suggestion }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({
      error: { code: failure.code, message: failure.message, retryable: true },
    });
  },
);

test("retains explicitly empty diagnostic collections", async () => {
  const response = dashboardOperationErrorResponse(
    DashboardOperationError.make({ ...failure, failures: [], progress: [] }),
  );
  expect(await response.json()).toEqual({
    error: {
      code: failure.code,
      message: failure.message,
      retryable: true,
      failures: [],
      progress: [],
    },
  });
});

test("returns complete public failure progress without the private operation or stack", async () => {
  const detail = {
    skill_name: "research",
    catalog_id: "catalog-research",
    phase: "downloading",
    code: "UNAVAILABLE",
    message: "Try later",
    retryable: true,
  } as const;
  const progress = CatalogSkillResolutionProgress.make({
    skill_name: "research",
    catalog_id: "catalog-research",
    phase: "downloading",
    message: "Retry download",
  });
  const response = dashboardOperationErrorResponse(
    DashboardOperationError.make({
      ...failure,
      suggestion: "Retry the skill",
      failures: [detail],
      progress: [progress],
    }),
  );
  expect(await response.json()).toEqual({
    error: {
      code: failure.code,
      message: failure.message,
      retryable: true,
      suggestion: "Retry the skill",
      failures: [detail],
      progress: [{ ...progress }],
    },
  });
});

test("adds CORS without losing response status, headers, or body", async () => {
  const response = withDashboardCors(
    new Response("conflict", {
      status: 409,
      statusText: "Conflict",
      headers: { "X-Test": "retained" },
    }),
  );
  expect(response.status).toBe(409);
  expect(response.statusText).toBe("Conflict");
  expect(response.headers.get("X-Test")).toBe("retained");
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
  expect(await response.text()).toBe("conflict");
});

test("requires an explicitly allowed request origin", () => {
  const allowed = new Set(["http://localhost:3141"]);
  expect(
    sameOriginFailure(
      new Request("http://localhost:3141/api", { headers: { Origin: "http://localhost:3141" } }),
      allowed,
    ),
  ).toBeNull();
  expect(sameOriginFailure(new Request("http://localhost:3141/api"), allowed)?.status).toBe(403);
  expect(
    sameOriginFailure(
      new Request("http://localhost:3141/api", { headers: { Origin: "https://other.invalid" } }),
      allowed,
    )?.status,
  ).toBe(403);
});

import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { HealthResponse } from "@selftune/runtime/dashboard-contract/health";

import { detectStaleClient, type StaleClientMismatch } from "@/lib/stale-client";

const ClientHealth = Schema.Struct({
  ok: HealthResponse.fields.ok,
  service: HealthResponse.fields.service,
  version: Schema.optionalKey(HealthResponse.fields.version),
  spa_build_id: HealthResponse.fields.spa_build_id,
});

const BUILD_INFO = {
  version: __SELFTUNE_PACKAGE_VERSION__,
  buildId: __SELFTUNE_SPA_BUILD_ID__,
};

const POLL_INTERVAL_MS = 30_000;

export function useStaleClient(): StaleClientMismatch | null {
  const [mismatch, setMismatch] = useState<StaleClientMismatch | null>(null);

  useEffect(() => {
    let isActive = true;

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) return;
        const payload = Schema.decodeUnknownSync(ClientHealth)(await response.json());
        if (isActive) setMismatch(detectStaleClient(payload, BUILD_INFO));
      } catch {
        // Keep the current state through transient health-check failures.
      }
    }

    void checkHealth();
    const interval = window.setInterval(() => void checkHealth(), POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  return mismatch;
}

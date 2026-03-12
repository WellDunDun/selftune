import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOverview } from "../api";
import type { OverviewResponse } from "../types";

type LoadState = "loading" | "ready" | "error";

const POLL_INTERVAL_MS = 15_000;

export function useOverview() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    const currentRequest = ++requestVersion.current;
    inFlight.current = true;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    setError(null);
    try {
      const payload = await fetchOverview();
      if (currentRequest !== requestVersion.current) return;
      setData(payload);
      setState("ready");
    } catch (err) {
      if (currentRequest !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : "Failed to load data");
      setState("error");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      await load();
      if (!cancelled) {
        pollTimer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      requestVersion.current += 1;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [load]);

  return { data, state, error, retry: load };
}

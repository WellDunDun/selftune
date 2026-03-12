import type { EvaluationRecord, OverviewPayload } from "./types";

const BASE = "";

export async function fetchOverview(): Promise<OverviewPayload> {
  const res = await fetch(`${BASE}/api/data`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchSkillEvaluations(skillName: string): Promise<EvaluationRecord[]> {
  const res = await fetch(`${BASE}/api/evaluations/${encodeURIComponent(skillName)}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

const MAX_SSE_RETRIES = 5;

export function createSSEConnection(
  onData: (payload: OverviewPayload) => void,
  retries = 0,
): () => void {
  const source = new EventSource(`${BASE}/api/events`);

  source.addEventListener("data", (e) => {
    try {
      const payload = JSON.parse(e.data) as OverviewPayload;
      onData(payload);
    } catch {
      if (import.meta.env.DEV) console.warn("SSE parse error", e.data);
    }
  });

  source.onerror = () => {
    source.close();
    if (retries < MAX_SSE_RETRIES) {
      const delay = Math.min(3000 * 2 ** retries, 30000);
      setTimeout(() => {
        const cleanup = createSSEConnection(onData, retries + 1);
        cleanupRef = cleanup;
      }, delay);
    }
  };

  let cleanupRef = () => source.close();
  return () => cleanupRef();
}

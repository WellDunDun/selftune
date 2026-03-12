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

export function createSSEConnection(onData: (payload: OverviewPayload) => void): () => void {
  const source = new EventSource(`${BASE}/api/events`);

  source.addEventListener("data", (e) => {
    try {
      const payload = JSON.parse(e.data) as OverviewPayload;
      onData(payload);
    } catch {
      // ignore parse errors
    }
  });

  source.onerror = () => {
    source.close();
    // reconnect after 3s
    setTimeout(() => {
      const cleanup = createSSEConnection(onData);
      // store cleanup for when outer cleanup is called
      cleanupRef = cleanup;
    }, 3000);
  };

  let cleanupRef = () => source.close();
  return () => cleanupRef();
}

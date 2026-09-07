// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useLiveActionFeed } from "@/lib/live-action-feed";
import { useSSE } from "./useSSE";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    TestEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup();
  TestEventSource.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores malformed stream messages and still processes subsequent valid actions", () => {
  vi.stubGlobal("EventSource", TestEventSource);
  const loading = vi.spyOn(toast, "loading").mockReturnValue("toast-test");
  const success = vi.spyOn(toast, "success").mockReturnValue("toast-test");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      useSSE();
      return useLiveActionFeed();
    },
    { wrapper },
  );
  const source = TestEventSource.instances[0];
  expect(source.url).toBe("/api/v2/events");
  act(() => {
    for (const data of ["{", "null", "[]", '{"action":"unknown"}', '{"event_id":1}']) {
      source.dispatchEvent(new MessageEvent("action", { data }));
    }
  });
  expect(loading).not.toHaveBeenCalled();
  const event = {
    event_id: "sse-boundary-test",
    action: "measure-baseline",
    stage: "started",
    skill_name: "research",
    skill_path: null,
    ts: Date.now() + 1,
  };
  act(() => source.dispatchEvent(new MessageEvent("action", { data: JSON.stringify(event) })));
  expect(loading).toHaveBeenCalledOnce();
  act(() =>
    source.dispatchEvent(
      new MessageEvent("action", {
        data: JSON.stringify({
          ...event,
          stage: "finished",
          success: true,
          metrics: { broken: true },
          ts: event.ts + 1,
        }),
      }),
    ),
  );
  expect(success).toHaveBeenCalledOnce();
  expect(view.result.current.find((entry) => entry.id === event.event_id)).toMatchObject({
    status: "success",
    metrics: null,
  });
  view.unmount();
  expect(source.closed).toBe(true);
  client.clear();
});

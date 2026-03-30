import { ZapIcon, CircleDotIcon } from "lucide-react";

import { timeAgo } from "../lib/format";
import { Badge } from "../primitives/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../primitives/card";

export interface RecentActivityItem {
  timestamp: string;
  session_id: string;
  skill_name: string;
  query: string;
  triggered: boolean;
  is_live: boolean;
}

export function RecentActivityFeed({
  items,
  embedded = false,
}: {
  items: RecentActivityItem[];
  embedded?: boolean;
}) {
  const content =
    items.length === 0 ? (
      <p className="py-6 text-center text-sm text-muted-foreground">No recent skill invocations</p>
    ) : (
      <div className="space-y-2.5">
        {items.slice(0, 20).map((item, i) => (
          <div
            key={`${item.session_id}-${item.skill_name}-${i}`}
            className="flex gap-3 rounded-md p-1.5"
          >
            <div
              className={`mt-0.5 w-10 h-10 shrink-0 rounded-xl bg-input flex items-center justify-center`}
            >
              <div
                className={`size-2 rounded-full ${
                  item.triggered
                    ? "bg-primary shadow-[0_0_8px_rgba(79,242,255,0.6)]"
                    : "bg-muted-foreground/40"
                }`}
              />
            </div>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-bold text-sm">{item.skill_name}</span>
                {item.is_live && (
                  <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px]">
                    <CircleDotIcon className="size-2.5 text-primary" />
                    live
                  </Badge>
                )}
                {item.triggered ? (
                  <Badge
                    variant="default"
                    className="h-4 px-1 text-[10px] font-bold uppercase tracking-tighter bg-primary/10 text-primary"
                  >
                    triggered
                  </Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    className="h-4 px-1 text-[10px] font-bold uppercase tracking-tighter"
                  >
                    checked
                  </Badge>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
                  {timeAgo(item.timestamp)}
                </span>
              </div>
              {item.query && (
                <p className="line-clamp-1 text-sm text-card-foreground leading-relaxed">
                  {item.query}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    );

  if (embedded) {
    return <div>{content}</div>;
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ZapIcon className="size-4" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent skill invocations
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ZapIcon className="size-4" />
          Recent Activity
        </CardTitle>
        <CardDescription>Latest skill invocations across sessions</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}

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

export function RecentActivityFeed({ items }: { items: RecentActivityItem[] }) {
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
      <CardContent className="space-y-2.5">
        {items.slice(0, 20).map((item, i) => (
          <div
            key={`${item.session_id}-${item.skill_name}-${i}`}
            className="flex gap-3 rounded-md p-1.5"
          >
            <div
              className={`mt-1 size-2 shrink-0 rounded-full ${
                item.triggered ? "bg-emerald-500" : "bg-muted-foreground/40"
              }`}
            />
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium truncate">{item.skill_name}</span>
                {item.is_live && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px] gap-1">
                    <CircleDotIcon className="size-2.5 text-emerald-500" />
                    live
                  </Badge>
                )}
                {item.triggered ? (
                  <Badge variant="default" className="h-4 px-1 text-[10px]">
                    triggered
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    checked
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground font-mono ml-auto shrink-0">
                  {timeAgo(item.timestamp)}
                </span>
              </div>
              {item.query && (
                <p className="text-xs text-muted-foreground line-clamp-1 font-mono">{item.query}</p>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

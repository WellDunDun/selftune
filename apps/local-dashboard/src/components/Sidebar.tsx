import { useState } from "react";
import type { SkillHealthStatus } from "../types";

const STATUS_OPTIONS: { label: string; value: SkillHealthStatus | "ALL" }[] = [
  { label: "All", value: "ALL" },
  { label: "Healthy", value: "HEALTHY" },
  { label: "Warning", value: "WARNING" },
  { label: "Critical", value: "CRITICAL" },
  { label: "Ungraded", value: "UNGRADED" },
];

export function Sidebar({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  counts,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: SkillHealthStatus | "ALL";
  onStatusFilterChange: (v: SkillHealthStatus | "ALL") => void;
  counts: Record<string, number>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar-left ${collapsed ? "collapsed" : ""}`}>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "\u203A" : "\u2039"}
      </button>

      {!collapsed && (
        <>
          <div className="sidebar-section">
            <label className="sidebar-label" htmlFor="skill-search">
              Search Skills
            </label>
            <input
              id="skill-search"
              type="text"
              className="sidebar-search"
              placeholder="Filter by name..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>

          <div className="sidebar-section">
            <span className="sidebar-label">Status</span>
            <div className="sidebar-filters">
              {STATUS_OPTIONS.map((opt) => {
                const count = opt.value === "ALL" ? undefined : counts[opt.value] ?? 0;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`filter-pill ${statusFilter === opt.value ? "active" : ""} ${opt.value !== "ALL" ? `filter-${opt.value.toLowerCase()}` : ""}`}
                    onClick={() => onStatusFilterChange(opt.value)}
                  >
                    {opt.label}
                    {count !== undefined && <span className="filter-count">{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

import type { SkillHealthStatus } from "../types";

const STATUS_COLORS: Record<SkillHealthStatus, { bg: string; text: string }> = {
  HEALTHY: { bg: "#d1fae5", text: "#059669" },
  WARNING: { bg: "#fef3c7", text: "#d97706" },
  CRITICAL: { bg: "#fee2e2", text: "#dc2626" },
  UNGRADED: { bg: "#e2e8f0", text: "#64748b" },
  UNKNOWN: { bg: "#e2e8f0", text: "#94a3b8" },
};

export function StatusPill({ status }: { status: SkillHealthStatus }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.UNKNOWN;
  return (
    <span
      className="status-pill"
      style={{ background: colors.bg, color: colors.text }}
    >
      {status}
    </span>
  );
}

import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CircleDotIcon,
  HelpCircleIcon,
  XCircleIcon,
} from "lucide-react";
import type { SkillHealthStatus } from "../types";

export const STATUS_CONFIG: Record<
  SkillHealthStatus,
  {
    icon: React.ReactNode;
    variant: "default" | "secondary" | "destructive" | "outline";
    label: string;
  }
> = {
  HEALTHY: {
    icon: <CheckCircleIcon className="size-4 text-emerald-600" />,
    variant: "outline",
    label: "Healthy",
  },
  WARNING: {
    icon: <AlertTriangleIcon className="size-4 text-amber-500" />,
    variant: "secondary",
    label: "Warning",
  },
  CRITICAL: {
    icon: <XCircleIcon className="size-4 text-red-500" />,
    variant: "destructive",
    label: "Critical",
  },
  UNGRADED: {
    icon: <CircleDotIcon className="size-4 text-muted-foreground" />,
    variant: "secondary",
    label: "Ungraded",
  },
  UNKNOWN: {
    icon: <HelpCircleIcon className="size-4 text-muted-foreground/60" />,
    variant: "secondary",
    label: "Unknown",
  },
};

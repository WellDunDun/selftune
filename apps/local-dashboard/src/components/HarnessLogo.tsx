import { HarnessIcon } from "@selftune/ui/components";
import type { HarnessConnection } from "@/types";

export function HarnessLogo({
  name,
  icon,
  className,
}: {
  name: string;
  icon: HarnessConnection["icon"];
  className?: string;
}) {
  return <HarnessIcon name={name} icon={icon} className={className} />;
}

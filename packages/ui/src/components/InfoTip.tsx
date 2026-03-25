import { InfoIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip";

/** Small info icon that shows a tooltip on hover. Used to explain metrics and concepts. */
export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className="inline-flex items-center text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-help"
        onClick={(e) => e.preventDefault()}
      >
        <InfoIcon className="size-3" />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px]">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

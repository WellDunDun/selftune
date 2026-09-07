import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { motion, useReducedMotion } from "../motion";

const Accordion = AccordionPrimitive.Root;

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return <AccordionPrimitive.Item className={cn(className)} {...props} />;
}

const AccordionHeader = AccordionPrimitive.Header;

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Trigger
      className={cn(
        "flex w-full items-center justify-between gap-3 py-2 text-left text-sm font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[panel-open]:[&_svg]:rotate-180",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  );
}

type AccordionContentProps = Omit<AccordionPrimitive.Panel.Props, "keepMounted" | "render">;

function AccordionContent({ className, ...props }: AccordionContentProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <AccordionPrimitive.Panel
      keepMounted
      className={className}
      render={({ children, ...renderProps }, state) => (
        <div {...renderProps} className={cn("overflow-hidden pb-2 text-sm", renderProps.className)}>
          <motion.div
            initial={false}
            animate={
              state.open
                ? { height: "auto", opacity: 1, y: 0 }
                : { height: 0, opacity: 0, y: shouldReduceMotion ? 0 : -4 }
            }
            transition={{ duration: shouldReduceMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        </div>
      )}
      {...props}
    />
  );
}

export { Accordion, AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger };

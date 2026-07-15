import claudeLogo from "@/assets/harnesses/claude.svg";
import codexLogo from "@/assets/harnesses/codex.svg";
import openClawLogo from "@/assets/harnesses/openclaw.jpg";
import openCodeLogo from "@/assets/harnesses/opencode.svg";
import piLogo from "@/assets/harnesses/pi.svg";
import type { HarnessId } from "@/types";

export const HARNESS_LOGOS: Record<HarnessId, string> = {
  claude_code: claudeLogo,
  codex: codexLogo,
  opencode: openCodeLogo,
  openclaw: openClawLogo,
  pi: piLogo,
};

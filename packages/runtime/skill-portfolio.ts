#!/usr/bin/env bun

import { handleCLIError } from "./utils/cli-error.js";
import { cliMain } from "./skill-portfolio/cli.js";

export type {
  PortfolioAuditEntry,
  PortfolioAuditResult,
  PortfolioClassification,
  PortfolioRecommendation,
  QuarantineReceipt,
  QuarantineRecord,
} from "./dashboard-contract.js";
export {
  buildPortfolioAudit,
  DEFAULT_INACTIVE_DAYS,
  DEFAULT_MIN_CHECKS,
  DEFAULT_MIN_SESSIONS,
  DEFAULT_ROUTING_MISS_RATE,
  detectConsolidationCandidates,
  loadPortfolioAudit,
} from "./skill-portfolio/audit.js";
export { cliMain } from "./skill-portfolio/cli.js";
export type {
  RunSkillsAuditOptions,
  RunSkillsQuarantineOptions,
  RunSkillsRestoreOptions,
} from "./skill-portfolio/programs.js";
export {
  formatSkillsAudit,
  formatSkillsQuarantined,
  formatSkillsReceipt,
  runSkillsAuditProgram,
  runSkillsQuarantinedProgram,
  runSkillsQuarantineProgram,
  runSkillsRestoreProgram,
} from "./skill-portfolio/programs.js";
export {
  listQuarantinedSkills,
  QUARANTINE_DIR,
  quarantineSkill,
  restoreQuarantinedSkill,
} from "./skill-portfolio/quarantine.js";

if (import.meta.main) cliMain().catch(handleCLIError);

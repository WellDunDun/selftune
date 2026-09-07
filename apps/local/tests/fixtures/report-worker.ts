import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildPortfolioAudit } from "@selftune/runtime/skill-portfolio";

const [, , mode, , , outputPath] = process.argv;
if (!outputPath) throw new Error("Expected report output path");
mkdirSync(dirname(outputPath), { recursive: true });
switch (mode) {
  case "exit":
    process.stderr.write("x".repeat(2048));
    process.exit(7);
    break;
  case "timeout":
    writeFileSync(outputPath, "unfinished");
    await Bun.sleep(15_000);
    break;
  case "invalid-json":
    writeFileSync(outputPath, "{");
    break;
  case "invalid-report":
    writeFileSync(outputPath, JSON.stringify({ installed_count: 99 }));
    break;
  case "valid":
    writeFileSync(outputPath, JSON.stringify(buildPortfolioAudit([], [], [])));
    break;
  default:
    throw new Error("Unknown worker fixture mode");
}

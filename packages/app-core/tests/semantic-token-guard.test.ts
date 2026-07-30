import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOCAL_DASHBOARD_SOURCE = [
  "oss/selftune/apps/local-dashboard/src",
  "apps/local-dashboard/src",
].find((directory) => existsSync(join(REPOSITORY_ROOT, directory)));

if (!LOCAL_DASHBOARD_SOURCE) {
  throw new Error("Could not locate the local dashboard source for the semantic token guard");
}

const PRODUCT_SOURCE_DIRECTORIES = [
  "packages/app-core",
  "packages/dashboard-core",
  "packages/ui/src",
  ...(existsSync(join(REPOSITORY_ROOT, "apps/cloud/src")) ? ["apps/cloud/src"] : []),
  LOCAL_DASHBOARD_SOURCE,
] as const;

const SOURCE_FILE_PATTERN = /\.(?:ts|tsx)$/;
const FIXED_PALETTE_PATTERN =
  /(?:\b(?:text|bg|border|ring|fill|stroke)-(?:white|black|slate|zinc|gray|neutral|red|green|emerald|amber|yellow|cyan|blue|purple|indigo|orange|lime|teal|sky|rose)-|#[0-9a-fA-F]{3,8}\b|rgba?\()/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE_PATTERN.test(entry.name) ? [path] : [];
  });
}

describe("semantic color token guard", () => {
  it("keeps product components free of fixed palette values", () => {
    const violations = PRODUCT_SOURCE_DIRECTORIES.flatMap((directory) =>
      sourceFiles(join(REPOSITORY_ROOT, directory)).flatMap((path) => {
        const matches = readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            FIXED_PALETTE_PATTERN.test(line)
              ? [`${relative(REPOSITORY_ROOT, path)}:${index + 1}`]
              : [],
          );
        return matches;
      }),
    );

    expect(violations).toEqual([]);
  });
});

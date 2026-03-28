import { describe, expect, test } from "bun:test";

import { derivePackageRootFromCommand } from "../../cli/selftune/init.js";

describe("derivePackageRootFromCommand", () => {
  // --- Unix paths with prefixes ---

  test("bun run prefix with /cli/selftune/hooks/ marker", () => {
    expect(
      derivePackageRootFromCommand("bun run /root/selftune/cli/selftune/hooks/prompt-log.ts"),
    ).toBe("/root/selftune");
  });

  test("node prefix with /bin/run-hook.cjs marker", () => {
    expect(
      derivePackageRootFromCommand(
        "node /root/selftune/bin/run-hook.cjs /root/selftune/cli/selftune/hooks/prompt-log.ts",
      ),
    ).toBe("/root/selftune");
  });

  // --- Paths with spaces ---

  test("path with spaces and bun run prefix", () => {
    expect(
      derivePackageRootFromCommand(
        "bun run /Users/Alice Smith/My Project/cli/selftune/hooks/prompt-log.ts",
      ),
    ).toBe("/Users/Alice Smith/My Project");
  });

  test("path with spaces and node prefix", () => {
    expect(derivePackageRootFromCommand("node /Users/Alice Smith/selftune/bin/run-hook.cjs")).toBe(
      "/Users/Alice Smith/selftune",
    );
  });

  // --- No prefix (path only) ---

  test("no prefix — bare Unix path with hooks marker", () => {
    expect(
      derivePackageRootFromCommand("/home/user/selftune/cli/selftune/hooks/prompt-log.ts"),
    ).toBe("/home/user/selftune");
  });

  test("no prefix — bare Unix path with bin marker", () => {
    expect(derivePackageRootFromCommand("/home/user/selftune/bin/run-hook.cjs")).toBe(
      "/home/user/selftune",
    );
  });

  // --- Quoted commands ---

  test("double-quoted path", () => {
    expect(
      derivePackageRootFromCommand(
        'node "/Users/Alice Smith/selftune/cli/selftune/hooks/prompt-log.ts"',
      ),
    ).toBe("/Users/Alice Smith/selftune");
  });

  test("single-quoted path", () => {
    expect(
      derivePackageRootFromCommand(
        "bun run '/Users/user/selftune/cli/selftune/hooks/prompt-log.ts'",
      ),
    ).toBe("/Users/user/selftune");
  });

  // --- Windows-style paths ---

  test("Windows drive letter with node prefix", () => {
    expect(
      derivePackageRootFromCommand("node C:/Users/dev/selftune/cli/selftune/hooks/prompt-log.ts"),
    ).toBe("C:/Users/dev/selftune");
  });

  test("Windows backslash path normalized", () => {
    expect(
      derivePackageRootFromCommand(
        "node C:\\Users\\dev\\selftune\\cli\\selftune\\hooks\\prompt-log.ts",
      ),
    ).toBe("C:/Users/dev/selftune");
  });

  // --- Non-matching inputs ---

  test("unrelated command returns null", () => {
    expect(derivePackageRootFromCommand("echo hello world")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(derivePackageRootFromCommand("")).toBeNull();
  });

  test("partial marker match returns null", () => {
    expect(derivePackageRootFromCommand("node /foo/cli/selftune/other/file.ts")).toBeNull();
  });
});

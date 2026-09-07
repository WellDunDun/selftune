import { expect, test } from "bun:test";
import { createLogger } from "@selftune/runtime/utils/logging";
import { createOutputCapture } from "../helpers/output-capture";

test("structured logging omits absent exceptions and retains real error details", () => {
  const capture = createOutputCapture();
  const original = process.stderr.write;
  process.stderr.write = capture.write;
  try {
    const logger = createLogger("test-module");
    logger.info("ready");
    logger.error("plain failure", "unstructured cause");
    logger.error("failed", new Error("test failure"));
    const records = capture
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ level: "INFO", module: "test-module", message: "ready" });
    expect(records[0]).not.toHaveProperty("exception");
    expect(records[1]).not.toHaveProperty("exception");
    expect(records[2]).toMatchObject({
      level: "ERROR",
      exception: expect.stringContaining("Error: test failure"),
    });
  } finally {
    process.stderr.write = original;
    capture.dispose();
  }
});

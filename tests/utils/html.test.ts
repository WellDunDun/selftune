import { describe, expect, it } from "bun:test";

import { escapeJsonForHtmlScript } from "../../cli/selftune/utils/html.js";

describe("escapeJsonForHtmlScript", () => {
  it("escapes html-significant characters in embedded JSON", () => {
    const escaped = escapeJsonForHtmlScript({
      text: '</script><!DOCTYPE html><script>alert("x")</script>&',
    });

    expect(escaped).toContain("\\u003c/script\\u003e");
    expect(escaped).toContain("\\u003c!DOCTYPE html\\u003e");
    expect(escaped).toContain("\\u0026");
    expect(escaped).not.toContain("</script>");
  });
});

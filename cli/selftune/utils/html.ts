/**
 * Escape JSON for safe embedding inside an HTML <script> tag.
 *
 * Escaping only </script> is not sufficient because arbitrary log payloads can
 * contain HTML-like substrings that confuse the parser in raw-text script
 * blocks. We escape all `<`, `>`, and `&` characters, plus the Unicode line
 * separators that can break JavaScript parsing in some engines.
 */
export function escapeJsonForHtmlScript(data: unknown): string {
  const json = JSON.stringify(data);
  return (json ?? "null").replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

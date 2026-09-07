import type { ESTree, SourceCode } from "@oxlint/plugins";

export type RuntimeFunction =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression;

export function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function justificationPattern(marker: string): RegExp {
  const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])${escaped}\s*:\s*\S`, "u");
}

/** Check a marker attached only to this runtime function's own declaration. */
export function hasFunctionSafetyJustification(
  sourceCode: SourceCode,
  node: RuntimeFunction,
  marker: string,
): boolean {
  const owners: ESTree.Node[] = [node];
  let declarationOwner: ESTree.Node = node;
  if (node.parent.type === "VariableDeclarator" && node.parent.init === node) {
    declarationOwner = node.parent;
    owners.push(declarationOwner);
    if (declarationOwner.parent.type === "VariableDeclaration") {
      declarationOwner = declarationOwner.parent;
      owners.push(declarationOwner);
    }
  }
  if (
    declarationOwner.parent.type === "ExportNamedDeclaration" &&
    declarationOwner.parent.declaration === declarationOwner
  ) {
    owners.push(declarationOwner.parent);
  }
  const pattern = justificationPattern(marker);
  return owners.some((owner) =>
    sourceCode
      .getCommentsBefore(owner)
      .some((comment) => comment.end <= node.start && pattern.test(comment.value)),
  );
}

/** Return the nearest runtime function containing a node, excluding outer functions. */
export function nearestRuntimeFunction(node: ESTree.Node): RuntimeFunction | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) return current;
    if (
      current.type === "TSInterfaceDeclaration" ||
      current.type === "TSTypeAliasDeclaration"
    )
      return null;
    current = current.parent;
  }
  return null;
}

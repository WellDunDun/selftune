import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
	const parent = node.parent;
	if (parent.type !== "BinaryExpression") return false;
	if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
	const other = parent.left === node ? parent.right : parent.left;
	return other.type === "Literal" && other.value === "undefined";
}

const JUSTIFICATION_PATTERN = /(?:^|[^\p{L}\p{N}_])SAFETY-TYPEOF\s*:\s*\S/u;
const JUSTIFICATION_OWNER_KINDS = new Set([
	"ExpressionStatement",
	"IfStatement",
	"ReturnStatement",
	"ThrowStatement",
	"VariableDeclaration",
]);

/** Return whether this check has a concrete justification on its statement or function. */
function hasRuntimeTypeofJustification(
	sourceCode: SourceCode,
	node: ESTree.UnaryExpression,
): boolean {
	let current: ESTree.Node = node;
	while (current.parent.type !== "Program") {
		current = current.parent;
		if (JUSTIFICATION_OWNER_KINDS.has(current.type) || isRuntimeFunction(current)) {
			const exportOwner =
				current.parent.type === "ExportNamedDeclaration" && current.parent.declaration === current
					? current.parent
					: null;
			const owners = exportOwner === null ? [current] : [current, exportOwner];
			if (owners.some((owner) =>
				sourceCode
					.getCommentsBefore(owner)
					.some((comment) => comment.end <= node.start && JUSTIFICATION_PATTERN.test(comment.value)),
			)) {
				return true;
			}
		}
		if (isRuntimeFunction(current)) return false;
	}
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks unless they are existence probes or carry a nearby SAFETY-TYPEOF justification for a boundary invariant TypeScript cannot express.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, or add a concrete `SAFETY-TYPEOF:` justification to this statement or containing function.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					!isExistenceProbe(node) &&
					!hasRuntimeTypeofJustification(context.sourceCode, node) &&
					(!allowInTypeGuards || !isInsideTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});

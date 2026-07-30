import type { ComposabilityInput } from "./composability-program.js";

export interface EvalGenerateInput {
  readonly skill?: string;
  readonly output?: string;
  readonly agent?: string;
  readonly max: string;
  readonly seed: string;
  readonly listSkills: boolean;
  readonly stats: boolean;
  readonly noNegatives: boolean;
  readonly noTaxonomy: boolean;
  readonly skillLog: string;
  readonly queryLog: string;
  readonly telemetryLog: string;
  readonly synthetic: boolean;
  readonly autoSynthetic: boolean;
  readonly blend: boolean;
  readonly skillPath?: string;
  readonly model?: string;
}

export interface EvalUnitTestInput {
  readonly skill?: string;
  readonly tests?: string;
  readonly runAgent: boolean;
  readonly generate: boolean;
  readonly skillPath?: string;
  readonly evalSet?: string;
  readonly model?: string;
}

export interface EvalImportInput {
  readonly dir?: string;
  readonly skill?: string;
  readonly output?: string;
  readonly matchStrategy: "exact" | "fuzzy";
}

export interface EvalFamilyOverlapInput {
  readonly prefix?: string;
  readonly skills?: string;
  readonly parentSkill?: string;
  readonly minOverlap?: string;
  readonly minShared?: string;
}

export type EvalCommandRequest =
  | { readonly action: "generate"; readonly input: EvalGenerateInput }
  | { readonly action: "unit-test"; readonly input: EvalUnitTestInput }
  | { readonly action: "import"; readonly input: EvalImportInput }
  | { readonly action: "composability"; readonly input: ComposabilityInput }
  | { readonly action: "family-overlap"; readonly input: EvalFamilyOverlapInput };

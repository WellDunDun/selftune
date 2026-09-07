import * as Schema from "effect/Schema";

export interface HarnessDetectionContext {
  homeDir: string;
  which: (command: string) => string | null;
}

export interface HarnessConnectionDetection {
  detected: boolean;
  connected: boolean;
  import_available: boolean;
  hooks_supported: boolean;
  hooks_installed: boolean;
  config_path: string;
  connected_detail: string;
}

export interface HarnessSourceMergeInvocation {
  agent: string;
  model?: string;
}

export interface HarnessRuntimeContribution {
  id: string;
  detectConnection?: (context: HarnessDetectionContext) => HarnessConnectionDetection;
  sourceMerge?: {
    invocation: (model: string | null) => HarnessSourceMergeInvocation;
  };
}

export interface HarnessPresentationIcon {
  src: string;
  fit: "contain" | "cover";
  inset: "none" | "sm";
  /** Monochrome glyphs drawn in near-black set this so hosts can invert them in dark mode. */
  invert_in_dark?: boolean;
}

export interface HarnessPresentation {
  id: string;
  name: string;
  description: string;
  icon: HarnessPresentationIcon;
  documentation_url: string | null;
}

export interface HarnessPackageContribution {
  presentation: HarnessPresentation;
  runtime: HarnessRuntimeContribution;
}

const HarnessPresentationIconSchema = Schema.Struct({
  src: Schema.String,
  fit: Schema.Literals(["contain", "cover"]),
  inset: Schema.Literals(["none", "sm"]),
  invert_in_dark: Schema.optional(Schema.Boolean),
});

const HarnessClientDescriptorSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  icon: HarnessPresentationIconSchema,
  documentation_url: Schema.NullOr(Schema.String),
  source_merge: Schema.NullOr(
    Schema.Struct({
      model_override: Schema.Boolean,
    }),
  ),
});

export type HarnessClientDescriptor = typeof HarnessClientDescriptorSchema.Type;

export class HarnessRegistryError extends Error {
  readonly code: "DUPLICATE_HARNESS" | "MISMATCHED_HARNESS" | "UNSAFE_PRESENTATION";

  constructor(code: HarnessRegistryError["code"], message: string) {
    super(message);
    this.name = "HarnessRegistryError";
    this.code = code;
  }
}

export interface HarnessRegistry {
  contributions: ReadonlyArray<HarnessPackageContribution>;
  get(id: string): HarnessPackageContribution | undefined;
  clientDescriptors(): ReadonlyArray<HarnessClientDescriptor>;
}

export function createHarnessRegistry(
  contributions: ReadonlyArray<HarnessPackageContribution>,
): HarnessRegistry {
  const byId = new Map<string, HarnessPackageContribution>();
  for (const contribution of contributions) {
    if (contribution.presentation.id !== contribution.runtime.id) {
      throw new HarnessRegistryError(
        "MISMATCHED_HARNESS",
        `Harness presentation ${contribution.presentation.id} does not match runtime ${contribution.runtime.id}.`,
      );
    }
    if (byId.has(contribution.runtime.id)) {
      throw new HarnessRegistryError(
        "DUPLICATE_HARNESS",
        `Harness ${contribution.runtime.id} is registered more than once.`,
      );
    }
    if (
      !contribution.presentation.icon.src.startsWith("data:image/") &&
      !contribution.presentation.icon.src.startsWith("https://")
    ) {
      throw new HarnessRegistryError(
        "UNSAFE_PRESENTATION",
        `Harness ${contribution.runtime.id} icon must use an image data URL or HTTPS URL.`,
      );
    }
    byId.set(contribution.runtime.id, contribution);
  }

  return {
    contributions: [...contributions],
    get: (id) => byId.get(id),
    clientDescriptors: () =>
      contributions.map(({ presentation, runtime }) =>
        Schema.decodeUnknownSync(HarnessClientDescriptorSchema)({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          icon: presentation.icon,
          documentation_url: presentation.documentation_url,
          source_merge: runtime.sourceMerge ? { model_override: true } : null,
        }),
      ),
  };
}

export function svgHarnessIcon(
  svg: string,
  options: Pick<HarnessPresentationIcon, "fit" | "inset" | "invert_in_dark"> = {
    fit: "contain",
    inset: "sm",
  },
): HarnessPresentationIcon {
  return {
    src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    ...options,
  };
}

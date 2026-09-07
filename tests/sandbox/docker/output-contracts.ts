import * as Schema from "effect/Schema";
import { GradingResult } from "@selftune/runtime/types";

export const parseGradingOutput = Schema.decodeUnknownSync(Schema.fromJsonString(GradingResult));

const decodeDryRunEvolution = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      deployed: Schema.Literal(false),
      reason: Schema.String.check(Schema.isNonEmpty()),
    }),
  ),
);
export const parseDryRunEvolutionOutput = (raw: string) =>
  decodeDryRunEvolution(raw, { onExcessProperty: "preserve" });

export const parseDoctorOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      checks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: Schema.Literals(["pass", "warn", "fail"]),
          message: Schema.String,
        }),
      ),
    }),
  ),
);

export function assertDiagnosticExit(exitCode: number, stdout: string): void {
  if ((exitCode !== 0 && exitCode !== 1) || stdout.trim().length === 0) {
    throw new Error(`Expected diagnostic output with exit 0 or 1; received exit ${exitCode}.`);
  }
}

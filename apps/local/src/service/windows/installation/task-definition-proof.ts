import * as Effect from "effect/Effect";

import {
  inspectWindowsServiceTaskLogonTriggerUserId,
  type WindowsServiceTaskDefinitionExpectation,
  type WindowsServiceTaskDefinitionMatch,
} from "./evidence.js";

export type WindowsServiceTaskDefinitionMatcher = (
  xml: string,
  expectation: WindowsServiceTaskDefinitionExpectation,
) => WindowsServiceTaskDefinitionMatch;

export function matchWindowsServiceTaskDefinitionWithAccountProof<E, R>(
  definition: string,
  expectation: WindowsServiceTaskDefinitionExpectation,
  matchDefinition: WindowsServiceTaskDefinitionMatcher,
  resolveWindowsAccountSid:
    | ((accountName: string) => Effect.Effect<string | null, E, R>)
    | undefined,
): Effect.Effect<WindowsServiceTaskDefinitionMatch, E, R> {
  const initialMatch = matchDefinition(definition, expectation);
  if (
    initialMatch.matches ||
    initialMatch.reason !== "logon-trigger-sid-mismatch" ||
    resolveWindowsAccountSid === undefined
  ) {
    return Effect.succeed(initialMatch);
  }
  const observedUserId = inspectWindowsServiceTaskLogonTriggerUserId(definition);
  if (observedUserId === null) return Effect.succeed(initialMatch);
  return resolveWindowsAccountSid(observedUserId).pipe(
    Effect.map((resolvedSid) => {
      if (
        resolvedSid === null ||
        resolvedSid.toLocaleLowerCase("en-US") !== expectation.userSid.toLocaleLowerCase("en-US")
      ) {
        return initialMatch;
      }
      return matchDefinition(definition, {
        ...expectation,
        provenLogonTriggerUserId: observedUserId,
      });
    }),
  );
}

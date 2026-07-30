import type * as Effect from "effect/Effect";

export interface ReceiptGenerationContract<TReceipt, TExpectation> {
  readonly absent: () => TExpectation;
  readonly fromReceipt: (receipt: TReceipt) => TExpectation;
  readonly matches: (receipt: TReceipt | null, expected: TExpectation) => boolean;
}

export interface DurableReceiptContract<TReceipt, TInput, TExpectation, EDecode, EEncode> {
  readonly create: (input: TInput) => TReceipt;
  readonly decode: (input: unknown) => Effect.Effect<TReceipt, EDecode>;
  readonly encodeForStorage: (receipt: TReceipt) => Effect.Effect<string, EEncode>;
  readonly generation: ReceiptGenerationContract<TReceipt, TExpectation>;
}

export function defineDurableReceiptContract<TReceipt, TInput, TExpectation, EDecode, EEncode>(
  contract: DurableReceiptContract<TReceipt, TInput, TExpectation, EDecode, EEncode>,
): DurableReceiptContract<TReceipt, TInput, TExpectation, EDecode, EEncode> {
  return contract;
}

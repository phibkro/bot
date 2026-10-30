import { Effect, Schema } from "effect";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

/** JSON text of a value, through Schema (no `JSON.stringify`): audit details, JWT parts and request bodies are built with it. */
export const encodeJson = (value: unknown): Effect.Effect<string> =>
  Schema.encodeEffect(UnknownJson)(value).pipe(Effect.orDie);

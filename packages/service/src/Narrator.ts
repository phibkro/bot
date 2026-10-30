import { Context, Effect, Layer } from "effect";
import type { Option } from "effect";

/**
 * The seam for a model (spec 0000, O1 and Revisions 1): v1 has none on the path, so the default implementation returns no
 * paragraph. A later `PiNarrator` (spec 0001) implements this service with read-only tools only; whatever it returns is
 * rendered inert by the comment template and posted by the deterministic `Notifier`. A narrator never decides, merges,
 * dispatches or comments.
 */
export class Narrator extends Context.Service<
  Narrator,
  {
    readonly paragraph: (context: {
      readonly kind: "report";
      readonly repository: string;
      readonly runUrl: string;
      readonly conclusion: string;
    }) => Effect.Effect<Option.Option<string>>;
  }
>()("bot/Narrator") {
  static readonly none = Layer.succeed(
    Narrator,
    Narrator.of({ paragraph: () => Effect.succeedNone })
  );
}

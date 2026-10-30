// Provenance: adapted from phibkro/pg-txmode @ 23be53c0c66a129540350697253b5c19abde3171 (vite.config.ts), which adapted it from
// reebeat/studio and phibkro/vektorprogrammet-reimagined @ 797e9e41d96194b9479ff224ac1c40bbc0545888. Deviations: the Effect groups
// name this repository's packages (rules: a pure library with no Effect; service and the app: Effect; the Worker host: the one
// runtime adapter); the `@bot/*` workspace imports go through their export maps. The language-service diagnostics run in
// `bun run check:effect`, not here (see `.agents/skills/effect-house/SKILL.md`).
import { effect } from "@phibkro/oxlint-effect-plugin";
import type { EffectConfigInput } from "@phibkro/oxlint-effect-plugin";
import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

const effectConfig: EffectConfigInput = {
  groups: [
    {
      files: ["packages/rules/src/**"],
      platform: "portable",
      role: "pure-library",
      strictness: "strict",
    },
    {
      files: ["packages/service/src/**", "apps/bot/src/ingress.ts"],
      platform: "portable",
      role: "service",
      strictness: "strict",
    },
    {
      files: ["apps/bot/src/layers.ts", "apps/bot/alchemy.run.ts"],
      platform: "web-worker",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["apps/bot/src/worker.ts"],
      platform: "web-worker",
      role: "runtime-adapter",
      strictness: "strict",
    },
    {
      files: ["packages/service/test/**", "apps/bot/test/**"],
      platform: "node",
      role: "test",
      strictness: "strict",
    },
  ],
};

const effectConfigResult = effect(effectConfig);

const restrictedSourcePatterns = [
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^@bot/[^/]+/src(?:/|$)",
  },
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^(?:\\./|(?:\\.\\./)+)(?:packages|apps|tools)/[^/]+/src(?:/|$)",
  },
];

export default defineConfig({
  // Prose is written by hand: Oxfmt re-wraps Markdown and joins hard line breaks, which changes meaning.
  fmt: {
    ...ultraciteFmt,
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      "**/*.md",
      "**/fixtures/**",
      ".agents/**",
    ],
  },
  lint: {
    extends: [core, antiSlop],
    ignorePatterns: ["**/fixtures/**", ".worktrees/**", "**/dist/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "complexity", specifier: "oxlint-plugin-complexity" },
      ...effectConfigResult.jsPlugins,
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      ...effectConfigResult.overrides,
      {
        // `func-names` asks a name for the generator that `Effect.gen(function* () {})` requires to be anonymous;
        // `promise-function-async` and the language-service `asyncFunction` disagree about every function that returns a promise.
        files: ["packages/service/**", "apps/bot/**"],
        rules: {
          "eslint/func-names": "off",
          "eslint/require-await": "off",
          "typescript/promise-function-async": "off",
          "unicorn/no-array-method-this-argument": "off",
        },
      },
      {
        // The Worker host: a Durable Object's RPC methods and `alarm` read nothing from `this` in some methods (EX-0001 covers the
        // Promise-based ABI itself, per site, in the file).
        files: ["apps/bot/src/worker.ts"],
        rules: {
          "eslint/class-methods-use-this": "off",
        },
      },
      {
        // `Schema.TaggedError` class definitions read as throw sites, and a closed set of errors reads as one table.
        files: [
          "packages/service/src/errors.ts",
          "apps/bot/src/ingress.ts",
          "packages/service/test/**",
        ],
        rules: {
          "eslint/max-classes-per-file": "off",
          "unicorn/throw-new-error": "off",
        },
      },
      {
        // Tables of declared data (the egress table, the contract table, the config, the generated checklist) read as lists.
        files: [
          "packages/service/src/github/egress.ts",
          "packages/rules/src/config.ts",
          "packages/rules/src/checklist.ts",
          "packages/rules/test/**",
        ],
        rules: {
          "eslint/max-lines": "off",
          "eslint/max-lines-per-function": "off",
          "unicorn/no-array-reduce": "off",
        },
      },
      {
        // Tests and the workerd smoke run steps in sequence: each waits for the one before it, and a hook awaits in a loop.
        files: ["**/test/**", "apps/bot/smoke/**"],
        rules: {
          // `Effect.map((value) => { assert... })` is Effect's `map`, not an array's: the rule cannot tell them apart.
          "eslint/array-callback-return": "off",
          "eslint/no-await-in-loop": "off",
          // DER encoding in the key test builds lengths with shifts.
          "eslint/no-bitwise": "off",
          "eslint/no-promise-executor-return": "off",
          "eslint/no-template-curly-in-string": "off",
          "node/callback-return": "off",
          "promise/avoid-new": "off",
          "promise/prefer-await-to-callbacks": "off",
          "promise/prefer-await-to-then": "off",
          "unicorn/consistent-function-scoping": "off",
        },
      },
      {
        // Relaxations, each with its reason:
        // - `complexity`: the orchestration in `Bot.ts` is a long sequence of reads, decisions and writes in one `Effect.gen` per
        //   workflow; splitting one at a branch would pass the state through a record just to satisfy a counter. The pure decisions
        //   (`decideMerge`, `decideDispatch`) are under the default limit; this file is not.
        // - `no-redeclare`: Effect's idiom is one name for the Schema value and its type (`const Hint = ...; type Hint = ...`).
        // - `consistent-function-scoping`: a helper beside the `Effect.gen` that uses it, closing over nothing, reads better there.
        // - `no-conditional-empty-object-spread`: the way to omit an optional property under `exactOptionalPropertyTypes`.
        // - `no-runtime-typeof`: narrowing a closed union (`string | object`) or an error value that is already inside the process.
        files: ["packages/service/**", "apps/bot/**"],
        rules: {
          "anti-slop/no-conditional-empty-object-spread": "off",
          "anti-slop/no-runtime-typeof": "off",
          // Audit details are any value that encodes to JSON; the parameter is encoded, never read.
          "anti-slop/no-unknown-parameters": "off",
          "complexity/complexity": ["error", { cognitive: 45 }],
          "eslint/no-redeclare": "off",
          "unicorn/consistent-function-scoping": "off",
        },
      },
      {
        // The workerd smoke reads its own committed fixtures and the object's audit JSON, and asserts on them: parsing each through a
        // Schema would restate the shapes the service tests already decode.
        files: ["apps/bot/smoke/**"],
        rules: {
          "anti-slop/no-array-filter-map": "off",
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-unknown-returns": "off",
          "anti-slop/require-safety-comment-for-type-assertion": "off",
          "typescript/no-invalid-void-type": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        // The package entry point re-exports the package's modules: that is its job.
        files: ["**/src/index.ts"],
        rules: { "oxc/no-barrel-file": "off" },
      },
      {
        // The one place where a closed union of two shapes is narrowed by its type: `_npmUser` is a string in old documents.
        files: ["packages/rules/src/publisher.ts"],
        rules: { "anti-slop/no-runtime-typeof": "off" },
      },
    ],
    rules: {
      "complexity/complexity": ["error", { cognitive: 15 }],
      // Its sibling `switch-exhaustiveness-check` makes the compiler name every case; a `default` would hide a new one.
      "eslint/default-case": "off",
      // A `const` used by a function that runs after the module has loaded is not a use before definition.
      "eslint/no-use-before-define": [
        "error",
        { functions: false, variables: false },
      ],
      "eslint/require-await": "off",
      "no-restricted-imports": [
        "error",
        { patterns: [...restrictedSourcePatterns] },
      ],
      // TypeScript's `noImplicitReturns` covers it; the rule disagrees with an `Effect.fn` generator that ends in a `yield*`.
      "typescript/consistent-return": "off",
      // Workspace modules use lower camelCase filenames; the Effect service files are named after their class.
      "unicorn/filename-case": [
        "error",
        { cases: { camelCase: true, pascalCase: true } },
      ],
      "unicorn/no-await-expression-member": "off",
      // Its autofix deletes the `undefined` argument that a call or an assertion needs (`Effect.as(undefined)`, `deepStrictEqual(x, undefined)`).
      "unicorn/no-useless-undefined": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  run: { cache: true },
  staged: { "*": "vp check --fix" },
});

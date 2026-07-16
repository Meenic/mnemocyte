# Needs Human Input

Decisions that exceeded the behavior-preserving cleanup pass. Option 1 was
approved and implemented for all three entries.

## BUG-01: Choose batch cancellation semantics

**Status:** Resolved with option 1 in
[`cf79854`](https://github.com/Meenic/mnemocyte/commit/cf798545f6c9b023e64a7fb5275c69cb91df3dae).

**Decision resolved:** Cancellation is owned by the batch, not by each
`RememberInput`.

Options:

1. Add an object-parameter batch API with one batch-level `signal`, preserving
   the current positional method as a compatibility overload during pre-v1.
2. Combine all item signals with `AbortSignal.any()`, so any item cancels the
   entire atomic batch.
3. Require all supplied item signals to be identical and reject mixed signals.

**Recommendation:** Use one explicit batch-level signal. A single embedding
request and insert operation cannot provide truthful per-item cancellation, and
an object-parameter form leaves room for future batch options. Preserve the
current signature temporarily if compatibility is required.

**Resolution:** Added `rememberMany({ inputs, signal })` and retained the
positional signature as a deprecated pre-v1 compatibility overload.

## BUG-02: Choose tuning validation and fallback policy

**Status:** Resolved with option 1 in
[`51cae0d`](https://github.com/Meenic/mnemocyte/commit/51cae0d8afc8d36039ffa4f7aa8b331ae18efd1f).

**Decision resolved:** Explicitly invalid numeric tuning is rejected with typed
errors.

Options:

1. Reject invalid values with typed errors at configuration/operation
   boundaries.
2. Fall back to defaults for invalid configuration and treat `maxTokens <= 0`
   as unlimited.
3. Clamp values into supported ranges and document the normalization.

**Recommendation:** Reject invalid values. At client construction, use
`"CONFIG"` for non-finite or negative weights, an effective weight total of
zero, non-finite/non-positive recency and access settings, and a
`candidateMultiplier` that is not an integer of at least one. At
`buildContext`, require `maxTokens` to be a positive integer when supplied and
use `"VALIDATION"`; omission remains the explicit unlimited/default path.

**Resolution:** Construction uses `"CONFIG"` for the approved invalid retrieval
settings, while `buildContext` uses `"VALIDATION"` for an invalid supplied
`maxTokens`.

## BUG-03: Choose metadata value and cloning semantics

**Status:** Resolved with option 1 in
[`43baf7d`](https://github.com/Meenic/mnemocyte/commit/43baf7d86c60e4563dbbf80924cd4eb79ea7b7ff).

**Decision resolved:** Metadata is JSON-compatible persisted value data.

Options:

1. Define recursive `JsonValue`/`JsonObject` types, reject non-JSON values, and
   deep-clone metadata at write and result boundaries for backend parity.
2. Keep `Record<string, unknown>` and use `structuredClone` in memory, accepting
   that Postgres still cannot represent every supported in-memory value.
3. Document shallow cloning and require callers not to mutate nested values,
   preserving the current backend difference.

**Recommendation:** Treat metadata as JSON-compatible persisted value data.
Validate it with a shared helper, reject unsupported/cyclic values with
`"VALIDATION"`, and deep-clone on ingress and egress. That matches JSONB's
natural contract and prevents returned values from mutating stored state. A
pre-v1 migration can introduce recursive JSON types while compatibility risk is
still manageable.

**Resolution:** Added recursive `JsonObject` / `JsonValue` types, shared runtime
validation, typed rejection, and deep cloning at both storage boundaries.

## Round 2: Deferred documentation judgments

Re-verified on 2026-07-16. These items remain deferred because current source,
tests, and synthetic benchmarks cannot settle them without maintainer judgment
or representative production workload evidence.

- **DOCS-DEF-01 — In-memory duplicate scale:** Define the per-entity size at
  which quadratic in-memory duplicate detection is no longer acceptable.
- **DOCS-DEF-02 — Performance priorities:** Choose production-relevant priority,
  risk, and “worth doing” thresholds for the performance backlog.
- **DOCS-DEF-03 — Provider package direction:** Decide whether provider adapters
  should eventually move from package subpaths into separate monorepo packages.
- **DOCS-DEF-04 — Adapter milestone sequencing:** Confirm or revise the planned
  ordering and version targets for public `MemoryStore`, `drizzleStore(db)`, and
  MCP adapter work.

No option was selected or changed during round-two verification.

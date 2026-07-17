# Needs Human Input

Decisions that exceeded the behavior-preserving cleanup pass. Option 1 was
approved and implemented for the first three behavior entries. The four
round-two documentation judgments were resolved by maintainer direction on
2026-07-17.

This file records the original cleanup decisions and the round-two
documentation judgments. No entry currently requires human input.
[`PROPOSALS.md`](../PROPOSALS.md) retains the implementation-proposal approval
and resolution history in one place.

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

## DOCS-DEF-01: Define in-memory duplicate-detection scale

**Status:** Resolved with option 1 by maintainer direction on 2026-07-17.

**Decision resolved:** The in-memory backend is for development and
prototyping. Its quadratic `findDuplicates` scan degrades noticeably beyond
roughly a few thousand memories per entity; Postgres is recommended beyond
that scale.

Options:

1. Document the intended development/prototyping scope, the rough
   few-thousand-per-entity degradation point, and the Postgres recommendation.
2. Continue describing quadratic work as acceptable for “typical” sizes
   without actionable scale guidance.
3. Publish a hard numeric support ceiling without representative workload
   evidence.

**Recommendation:** Use qualitative operational guidance with only the rough
scale supplied by the maintainer. It gives users a backend-selection signal
without presenting a benchmark-specific cutoff as a universal limit.

**Resolution:** README and architecture guidance now identify the in-memory
backend as a development/prototyping path, warn that duplicate detection
degrades noticeably past roughly a few thousand memories per entity, and
recommend Postgres beyond that scale.

## DOCS-DEF-02: Set performance backlog priorities

**Status:** Resolved with option 1 by maintainer direction on 2026-07-17.

**Decision resolved:** Performance work follows a qualitative priority order:
correctness and data integrity first; then hot-path latency for `recall` and
`buildContext`; then write-path throughput; and tooling or benchmarks last.

Options:

1. Adopt the qualitative priority order without inventing numeric acceptance
   thresholds.
2. Keep the backlog ordered by the existing P1/P2 labels even when that mixes
   hot paths, write throughput, and benchmarking work.
3. Define latency or throughput thresholds without representative production
   evidence.

**Recommendation:** Use the qualitative order as the decision rule and require
measurements only when evaluating a concrete optimization. Numeric global
thresholds would imply precision the repository cannot support.

**Resolution:** `PERFORMANCE_REVIEW.md` now states the priority rule and orders
its active backlog accordingly. Correctness or data-integrity regressions
preempt all optimization work even when they are tracked outside the
performance document.

## DOCS-DEF-03: Keep provider helpers on package subpaths

**Status:** Resolved with option 1 by maintainer direction on 2026-07-17.

**Decision resolved:** Provider helpers stay on package subpaths such as
`mnemocyte/embedders/openai` for the near term.

Options:

1. Keep package subpaths until a second provider exists or one provider needs
   a heavy or conflicting SDK dependency, then reevaluate package boundaries.
2. Split the current OpenAI helper into a separate monorepo package now.
3. Move provider behavior into the root package entrypoint.

**Recommendation:** Keep the current subpath design. One lightweight,
`fetch`-based helper does not justify monorepo/package overhead, and the root
entrypoint must remain provider-free.

**Resolution:** The roadmap treats subpaths as the settled near-term direction.
A second provider or a heavy/conflicting SDK dependency is the explicit trigger
for reconsidering separate packages, not a commitment to split automatically.

## DOCS-DEF-04: Confirm adapter milestone sequencing

**Status:** Resolved with option 1 by maintainer direction on 2026-07-17;
version targets superseded by the later `0.4.0` release allocation.

**Decision resolved:** Preserve the existing sequence: stabilize the public
`MemoryStore` contract, then ship `drizzleStore(db)`, then ship
`@mnemocyte/mcp`.

Options:

1. Confirm the existing architecture-first sequence and version targets.
2. Move MCP ahead of the public store and Drizzle adapter.
3. Ship the Drizzle adapter before defining the public `MemoryStore` contract.

**Recommendation:** Keep the existing order so both later adapters build on one
reviewed public storage contract rather than creating parallel abstractions.

**Resolution:** `ROADMAP.md` and `PROJECT_MEMORY.md` mark the sequence as a
confirmed decision rather than an open question. Preparing the existing
hardening changes as `0.4.0` advanced the still-unshipped Drizzle and MCP
targets to `0.5.0` and `0.6.0`; their order was not changed.

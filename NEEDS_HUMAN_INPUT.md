# Needs Human Input

Decisions that exceed a behavior-preserving cleanup pass.

## BUG-01: Choose batch cancellation semantics

**Decision required:** Is cancellation owned by the batch or by each
`RememberInput`?

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

**Why deferred:** Each option changes observable cancellation behavior or the
public method shape; the codebase audit is not authorized to choose that
contract.

## BUG-02: Choose tuning validation and fallback policy

**Decision required:** Should explicitly invalid numeric tuning be rejected,
clamped, or replaced by defaults?

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

**Why deferred:** The current API accepts these values, and choosing rejection,
fallback, or clamping changes public behavior and error timing.

## BUG-03: Choose metadata value and cloning semantics

**Decision required:** Is metadata JSON-compatible value data, arbitrary
JavaScript data, or explicitly caller-owned shallow data?

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

**Why deferred:** Narrowing `Record<string, unknown>` and changing clone/error
behavior affects public types, accepted inputs, and backend compatibility.

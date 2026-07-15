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

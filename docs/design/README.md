# MemoryStore Contract Design Investigation

No file in this folder is a finalized implementation contract. Drafts preserve
the proposal at that point in the investigation; verification reports preserve
evidence at their recorded commit and do not make the draft they review
authoritative. Superseded wording remains here for traceability.

For current behavior, use source, tests, migrations, package configuration,
the root [`README.md`](../../README.md), [`CHANGELOG.md`](../../CHANGELOG.md),
and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md). Future direction is governed
by [`docs/ROADMAP.md`](../ROADMAP.md), maintainer context by
[`docs/PROJECT_MEMORY.md`](../PROJECT_MEMORY.md), and approval-sensitive
changes by root [`PROPOSALS.md`](../../PROPOSALS.md).

## Chronology and authority

1. [`MONOREPO_READINESS_REPORT.md`](./MONOREPO_READINESS_REPORT.md) is the
   initial evidence snapshot at its stated revision. It is historical evidence,
   not a current repository-state promise.
2. [`memorystore-capability-contract.md`](./memorystore-capability-contract.md)
   is the superseded capability-contract draft.
3. [`CONTRACT_DESIGN_VERIFICATION.md`](./CONTRACT_DESIGN_VERIFICATION.md)
   verifies that first draft and the exploratory
   [`sqlite-adapter-design-notes.md`](./sqlite-adapter-design-notes.md). It
   records interface omissions, unsupported flags, and SQLite contract gaps.
4. [`memorystore-capability-contract-v2.md`](./memorystore-capability-contract-v2.md)
   is the corrected capability draft.
5. [`CONTRACT_DESIGN_VERIFICATION_V2.md`](./CONTRACT_DESIGN_VERIFICATION_V2.md)
   confirms most corrections but rejects v2 as implementation-ready. In
   particular, indexed vector search is a real backend distinction, not proof
   that a public capability surface is needed.
6. [`public-memorystore-stabilization.md`](./public-memorystore-stabilization.md)
   begins the narrower public-contract stabilization investigation.
7. [`STABILIZATION_PROPOSAL_VERIFICATION.md`](./STABILIZATION_PROPOSAL_VERIFICATION.md)
   finds backend edge differences, incorrect combined cancellation wording,
   and an overbroad indexed-search framing.
8. [`public-memorystore-stabilization-v2.md`](./public-memorystore-stabilization-v2.md)
   is the first stabilization correction.
9. [`STABILIZATION_PROPOSAL_VERIFICATION_V2.md`](./STABILIZATION_PROPOSAL_VERIFICATION_V2.md)
   confirms the overall direction while identifying remaining ownership,
   counting, path, and wording errors.
10. [`public-memorystore-stabilization-v3.md`](./public-memorystore-stabilization-v3.md)
    is the latest proposal draft.
11. [`STABILIZATION_PROPOSAL_VERIFICATION_V3.md`](./STABILIZATION_PROPOSAL_VERIFICATION_V3.md)
    is the latest verification. It rejects v3 as a final implementation basis:
    store return order is still assigned to the wrong layer,
    `findDuplicatePairs` overstates the absence of every index, Postgres-only
    cancellation behavior is presented without its backend qualifier, and the
    description of the changed documentation track is internally inconsistent.

The capability investigation and stabilization investigation intentionally end
at different recommendations. The former identifies indexed vector search as a
candidate distinction; the latter recommends no public capability flag without
a concrete consumer. The canonical current decision is to defer a capability
surface. No design in this folder is currently implementation-ready.

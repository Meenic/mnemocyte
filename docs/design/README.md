# MemoryStore Contract Design Investigation

**No file in this folder should be treated as a finalized,
implementation-ready contract yet.** The next step is a v3 revision that
resolves round 2's remaining open items: the survivor race-time error code,
the survivor tag-merge source, the audit-event field specification, and whether
the surviving capability flag needs a defined public surface at all. Do not
implement against v2 as-is.

The files are ordered below by their role in the investigation:

- [`MONOREPO_READINESS_REPORT.md`](./MONOREPO_READINESS_REPORT.md) is the
  evidence-gathering pass that started this investigation. It remains accurate
  as of its stated date and is the foundational reference for the documents
  that followed.
- [`memorystore-capability-contract.md`](./memorystore-capability-contract.md)
  is the first capability-contract draft. It is **superseded** and contains
  confirmed factual errors documented by round 1. It is retained for history,
  not as an implementation reference.
- [`CONTRACT_DESIGN_VERIFICATION.md`](./CONTRACT_DESIGN_VERIFICATION.md) is the
  round 1 verification. It found that the first draft invented and omitted
  real `MemoryStore` methods, misapplied several proposed capability flags, and
  left a survivor-race gap in the SQLite `consolidate` design. The v2 draft was
  written to address those findings.
- [`sqlite-adapter-design-notes.md`](./sqlite-adapter-design-notes.md) covers
  the four hardest proposed SQLite methods. Its `consolidate` section is
  **superseded** by v2's corrected sequence. The other three sections
  (`vectorSearch`, `findDuplicatePairs`, and `prune`) were not revised in v2
  and should be read alongside section 3 of the round 1 verification rather
  than treated as fully verified.
- [`memorystore-capability-contract-v2.md`](./memorystore-capability-contract-v2.md)
  is the current draft. It fixes most round 1 findings, and round 2 confirms
  the interface work and most decisions about dropped or retained flags.
  Round 2 also finds that v2 overgeneralizes the in-memory
  referential-integrity mechanism and how strongly the surviving flag is
  justified, while leaving several `consolidate` race-time details
  underspecified. It is the most current draft, but it is **not yet
  implementation-ready**.
- [`CONTRACT_DESIGN_VERIFICATION_V2.md`](./CONTRACT_DESIGN_VERIFICATION_V2.md)
  is the round 2 verification. Its open items are the remaining work that must
  be resolved before the contract can be treated as a finalized specification.

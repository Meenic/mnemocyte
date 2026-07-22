# `drizzleStore(db)` — v1 Design Proposal v2

Status: implementation complete in
[`a9e848f`](https://github.com/Meenic/mnemocyte/commit/a9e848fd42e8245f9612c2ce563a5ec5b1d05788).
The final public path is the wildcard-backed `mnemocyte/stores/drizzle`, per
the pre-merge export-pattern correction. This design incorporates
`docs/design/DRIZZLESTORE_V1_DESIGN_VERIFICATION.md`'s four corrections and
resolves its three flagged maintainer decisions. Scope, evidence, and the
postgres.js-only boundary are unchanged from v1 — see that document for the
full rationale.

## Corrections from verification

1. **Schema typing, better than v1 assumed.** The public type accepted for
   a caller-supplied `db` should be a structural, non-exact type — e.g.
   `PostgresJsDatabase<Record<string, unknown>>` or an equivalent generic
   parameter, **not** `PostgresJsDatabase<typeof schema>`. Verification
   confirmed this compiles clean against real source with zero diagnostics
   and requires no caller-side schema merging.
2. **`close()` cannot be omitted.** `DatabaseHandle.close` is required and
   called unconditionally by `createPostgresStore()`. A caller-supplied
   handle needs a required callback that resolves as a no-op — not a
   missing/optional one.
3. **Peer-dependency conversion is explicitly deferred, not part of this
   implementation.** Verification confirmed npm peer dependencies are
   package-wide, not subpath-scoped — this can't be "just for
   `mnemocyte/stores/drizzle`." `drizzle-orm` and `postgres` stay as direct
   dependencies for v1, exactly as they are today. Converting them to peer
   dependencies package-wide is real, separate, valuable future work
   (closes the gap between "Postgres code doesn't run unless used" and
   "Postgres packages aren't installed unless used") — track it as its own
   follow-up, don't fold it into this feature.
4. **Documentation surface is larger than v1 scoped.** Beyond README and
   the new subpath's own docs, these existing comments assert something
   that becomes false once `store` exists and must be updated:
   - `src/types.ts:59-65` and `:181-190` — backend selection currently
     described as depending only on `databaseUrl`.
   - `src/client.ts:13-19` — "omitting `databaseUrl` selects in-memory."
   - `src/client.ts:21-23` — "the returned client owns its Postgres
     resources."
   - `docs/ARCHITECTURE.md:79-84,288-341,683-693` — public-surface, config,
     and connection-lifecycle sections describe only the URL-owned path.
   `MnemocyteClient.close()`'s existing comment
   (`src/types.ts:961-969`) needs no change — it's already compatible,
   phrased as "releases resources," not "always ends the connection."

## Resolved decisions

**Config field name and type:** `store`, added as an optional field to
`MnemocyteConfig` alongside `databaseUrl`. Since `MemoryStore` stays
internal, export a minimal, narrowly-scoped public type for this field
specifically — it does not need to be the full internal `MemoryStore`
interface renamed and exported wholesale. `drizzleStore(db)` returns a
value structurally compatible with that public type; exact naming and
whether it's a type alias or a distinct narrower interface is an
implementation-level call, not something this design needs to pin down
further.

**`databaseUrl` + `store` precedence:** reject the combination outright
with `"CONFIG"`, at the same synchronous validation point where
`databaseUrl`'s own malformed/empty checks currently happen. No defined
precedence, no silent "one wins" — consistent with this project's
established preference for rejecting ambiguous input over guessing intent
(same call made for `BUG-02`'s tuning validation, `CONFIG-02`'s protocol
rejection, and `CONSOLIDATION-02`'s duplicate-ID rejection).

**Peer dependencies:** deferred, per correction 3 above. Not part of this
implementation.

## Unchanged from v1

Postgres.js-only scope, the new `DatabaseHandle` constructor path for a
caller-supplied instance, the ownership-aware `close()` mechanism (now
corrected to "required no-op callback" per verification), the
subpath-packaging approach (`mnemocyte/stores/drizzle`, using the same wildcard
pattern as `mnemocyte/embedders/*`), `ensureSchema()` staying a
no-op, the public/schema/pre-migrated documented constraints, and the one
required integration test (construct a real postgres.js Drizzle instance
outside any Mnemocyte factory, hand it to Mnemocyte, use it, close it,
confirm the original instance still works).

## Next step

This is ready for implementation. No further design-verification round
needed — the three prior decisions were genuinely open questions needing a
maintainer call, not codebase facts; they're now resolved.

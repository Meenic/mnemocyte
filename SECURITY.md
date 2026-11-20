# Security

## Supported versions

Security fixes go into the newest 1.x minor and ship as a patch release.
To get a fix, update to the latest `mnemocyte` 1.x.

| Version | Gets security fixes |
|---|---|
| Newest 1.x minor | Yes |
| Older 1.x minors | No, update to the newest |
| 0.x | No, see [Upgrading from 0.x](docs/guide/upgrading.md) |

## Report a vulnerability

Please report it privately, not in a public issue, pull request or
discussion.

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/Meenic/mnemocyte/security/advisories/new).
The same button is on the repository's **Security and quality** tab. The
report stays private: only you, the maintainer and anyone either of you
adds to it can see it.

Include what you can:

- the `mnemocyte` version, the backend (in-memory or Postgres) and the
  driver (postgres.js, node-postgres, PGlite, Drizzle);
- the steps or code that show the problem;
- what an attacker could do with it.

If you can't use GitHub's form, open an issue that asks for a security
contact and leaves out the details.

## What counts

For example:

- a call that reads, changes or deletes memories outside the scope it was
  given;
- SQL injection through any input, option or schema name;
- API keys, database credentials or other secrets showing up in errors,
  events, logs or CLI output;
- input that gets past the [input limits](docs/guide/api.md#input-limits)
  and exhausts memory or the stack.

Not sure? Report it anyway. A problem in a driver or the AI SDK belongs
to that project, but report it here too if Mnemocyte makes it worse.

## What happens next

The maintainer works on a fix with you in the private report. The fix
ships as a patch release, and then the advisory is published with credit
to you, unless you'd rather not be named.

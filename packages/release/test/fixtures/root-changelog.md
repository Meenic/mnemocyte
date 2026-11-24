# Changelog

All notable changes to `mnemocyte` are documented here.

## [Unreleased]

### Added

- **Save memories with tags.** `remember({ tags })` keeps them; see
  [the guide](docs/guide/api.md#tags).

### Fixed

- **Recall no longer drops the last result.** It returned one fewer.

## [1.1.0] - 2026-11-16

The first minor, for teams on Drizzle; see
[upgrading](docs/guide/upgrading.md#10--11).

### Added

- **Pick the keyword search language.** `textSearchConfig` names it.
- **`mnemocyte check` reads the [installation](docs/guide/cli.md#check).**
  It lists what is missing.

### Changed

- **Errors name the option.** As in [1.0.0](#100---2026-11-15).

## [1.0.0] - 2026-11-15

The stable release.

### Documentation

- **README rewritten for a first-time user.** Shorter.

## [0.9.0] - 2026-11-01

- an entry from before lead-ins

[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Meenic/mnemocyte/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Meenic/mnemocyte/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/Meenic/mnemocyte/releases/tag/v0.9.0

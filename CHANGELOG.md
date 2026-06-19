# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-19

Security and data-integrity release. Contains two breaking changes — see
**Upgrade notes** below.

### Security
- TLS server-certificate validation is now **enabled by default**. Previously,
  enabling SSL used `rejectUnauthorized: false`, which encrypted the traffic but
  did not verify the server, leaving connections open to man-in-the-middle
  attacks. A **CA cert** field and an explicit **Validate cert** opt-out were
  added to the config node.

### Fixed
- Activated the `home`/`industrial` schema, which was previously dead code:
  integers now go to `value_int` (home) or `value_bigint` (industrial). The
  default is `industrial`, matching the previous effective behaviour.
- String value-type detection no longer mis-classifies `''`, whitespace,
  `'0x1F'`, `'Infinity'`, etc. as numbers; such values are stored as text.
- Large integers keep full precision (integer strings are passed straight to
  `BIGINT` instead of through a lossy JS `Number`).
- `NaN`/`Infinity` numbers are stored as text instead of erroring against a
  numeric column.
- An invalid `msg.timestamp` falls back to the current time with a warning
  instead of producing an invalid date.
- Nodes no longer crash on startup when the server config node is missing; they
  report an error and show a red status instead.
- Invalid Fixed Tags JSON now produces a warning instead of being silently
  ignored.

### Changed
- The PostgreSQL connection pool is now owned and shared by the config node and
  reused by all nodes, instead of one pool per node. A pool `error` handler was
  added so a dropped idle connection can no longer crash Node-RED.
- Shared value-detection and insert logic was extracted into `lib/timescale.js`,
  removing the duplication between the two nodes.
- Packaging: the published file set is restricted via a `files` whitelist;
  added `package-lock.json`; bumped the minimum Node version to 16 (required by
  `pg`).

### Upgrade notes (breaking changes)
1. **TLS validation.** If you connect over SSL to a server using a self-signed
   or otherwise untrusted certificate, connections will start failing after this
   upgrade. Either paste the server's CA certificate into the new **CA cert**
   field, or uncheck **Validate cert** (insecure — disables MITM protection) on
   the TimescaleDB config node.
2. **Schema column.** Integer values now respect the **Schema** setting. With
   the default `industrial` they continue to go to `value_bigint` (no change
   from the previous real behaviour); set **Schema** to `home` if you want
   integers stored in `value_int`.

## [0.1.0]

- Initial release.

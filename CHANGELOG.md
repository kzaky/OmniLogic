# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2026-05-20

### Fixed

- The 1.0.1 publish workflow failed before npm publish — root cause not
  fully identified from sandbox without log access, but `package-lock.json`
  was out of sync with `package.json` (still at 1.0.0). Re-syncing the
  lockfile and bumping again.

## [1.0.1] - 2026-05-12

### Fixed

- **Config schema validation** for Homebridge verification. The `required`
  flag was set as a boolean on individual fields (`name`, `username`,
  `password`), which is invalid JSON Schema and was rejected by the
  Homebridge plugin-verification bot. Moved to a top-level
  `"required": ["name", "username", "password"]` array.

### Changed

- **Publish workflow now creates a GitHub Release** on every tag push.
  Required for Homebridge verification ("GitHub Repo: should contain
  releases"). Release notes are auto-extracted from the matching
  CHANGELOG section; prereleases are marked as such.

## [1.0.0] - 2026-05-12

First stable release. All features validated against real hardware.

### Added

- Relay accessories exposed as Switches (new `exposeRelays` config option, default `true`).

### Changed

- Promoted from beta to stable. Install with `npm install homebridge-omnilogic-pool`.

### Fixed

- Removed dead `EquipmentRef.raw` and `BackyardTopology.rawMsp` fields.
- `OmniLogicApi.login()` made private; redundant `ensureLogin()` call removed from request path.
- Dead branch in `firstString` removed.
- `namedChildren` helper now has full unit test coverage.

## [0.1.0-beta.7] - 2026-05-12

### Fixed

- `SetHeaterEnable` was sending the boolean as a parameter named
  `HeaterEnable`, which the API rejects with `Status=3`. djtimca's
  Python client uses the name `Enabled`. Switched to match.

## [0.1.0-beta.6] - 2026-05-12

### Fixed

- **Filter pump now exposed as a Switch, not a Fan.** Hardware test
  showed `SetUIFilterSpeedCmd` returns `Status=5 "This operation is
  not supported"` against single-speed pumps (the common case). All
  filter pumps now use `SetUIEquipmentCmd` for on/off. Old Fan service
  on existing accessories is automatically removed on first start so
  HomeKit shows just the Switch.
- **Chlorinator no longer reports "always on".** Switch telemetry was
  using `operatingMode > 0` to derive HomeKit on/off state, but
  `operatingMode` is the chlorination *mode* (1 = Timed, 2 = %-output,
  etc.) — always non-zero on a configured chlorinator. Now uses
  `enable` attribute (1/0 or "yes"/"no") instead. Fixes the "switch
  keeps turning back on" symptom.
- **Heater enable parses `"yes"`/`"no"` string values.** Real
  telemetry uses `<VirtualHeater enable="no"/>`; previously only
  numeric or `"true"`/`"false"` were recognised, so a `"yes"`-state
  heater would always read as off in HomeKit.

### Removed

- `FilterPumpAccessory` (Fan-with-speed model). If variable-speed
  support comes back, it will be driven by MSP-config-based detection
  rather than assumed.

## [0.1.0-beta.5] - 2026-05-12

### Fixed

- `UserID` was being sent as an empty string in `GetSiteList`, causing
  the API to respond `Status=6 / "Input string was not in a correct
  format"`. Root cause was two compounding bugs:
  1. `applyAuthResponse` rejected `userID` unless it was a string. If
     the auth API returns it as a number (likely), we dropped it.
     Now coerced via a `coerceString` helper that accepts string,
     number, or boolean.
  2. `ensureLogin` always restored from cache, overwriting the
     in-memory userId set by a fresh login. Reordered so cache is
     only consulted when the in-memory token is expired or absent.
- Removed redundant `api.login()` call in `discover()`. `getSiteList`'s
  `ensureLogin` now handles auth path selection (fresh-token / cache /
  refresh / login) without the platform pre-empting it.

### Changed

- Token cache schema bumped to `v: 3` to invalidate `v: 2` caches that
  may have stored `userId: null` from beta-2/3/4 runs. One re-login
  needed on upgrade.
- `applyAuthResponse` logs the response keys when `debug: true`, and
  always includes `userId=...` in the success line. Quick way to see
  whether we extracted it correctly without enabling the full XML
  trace.

## [0.1.0-beta.4] - 2026-05-12

### Changed

- Diagnostic: when `getSiteList` parsing fails (no `<Item>` element, or
  the item is missing `MspSystemID`), the first 1000 chars of the raw
  response are logged at `warn` level. Beta-3 didn't yield enough
  signal to fix the parser; this gets the response shape into normal
  logs without relying on `debug: true` opt-in.

## [0.1.0-beta.3] - 2026-05-12

### Fixed

- `getSiteList` was looking for `<Site>` elements in the response. The
  post-2025 API returns sites as `<Item>` containers whose child
  elements are identified by a `name` attribute regardless of element
  tag. Now walks the response with a generic `namedChildren` helper
  matching djtimca/omnilogic-api's traversal.

### Changed

- Debug-mode request/response logging now uses `log.info` instead of
  `log.debug`. Homebridge suppresses `debug`-level output unless run
  with `-D`, which meant the `debug: true` config option produced no
  visible output. Now opting in actually surfaces the XML traffic.

## [0.1.0-beta.2] - 2026-05-12

### Changed

- **Breaking (pre-1.0):** rewritten against Hayward's post-2025 cloud API.
  The old `.asmx` SOAP endpoint at
  `www.haywardomnilogic.com/HAAPI/HomeAutomation/HomeAutomationService.asmx`
  was retired and now returns 404. The plugin now talks to:
  - `services-gamma.haywardcloud.net/auth-service/v2/login` for REST/JSON
    login (payload `{ email, password }`).
  - `services-gamma.haywardcloud.net/auth-service/v2/refresh` for bearer
    token refresh with the refresh token from login.
  - `www.haywardomnilogic.com/HAAPI/HomeAutomation/API.ashx` for data, with
    `Token` and `SiteID` HTTP headers and a plain `<Request>` XML body (no
    SOAP envelope).
- The required `X-HAYWARD-APP-ID` header is sent on auth requests.
- Auth-retry triggers on HTTP 401/403 (the old XML in-body status check is
  no longer the failure signal).
- Token cache bumped to `v: 2` to add `refreshToken`; v1 caches are ignored
  on load, forcing one re-login after upgrade.
- `buildSoapRequest` renamed to `buildRequestXml`; `isAuthFailureXml`
  removed.

## [0.1.0-beta.1] - 2026-05-11

First public beta. Published under the `beta` dist-tag while real-world
firmware coverage is gathered; install with
`npm install homebridge-omnilogic-pool@beta`.

### Added

- Test suite (`node:test` via `tsx`) covering the XML/SOAP helpers
  (redaction, parser variants, topology builder, telemetry indexing,
  auth-failure detection) and `TokenStore` (file mode, round-trip,
  expiry, wrong-user rejection, corrupted file, atomic write). `npm
  test` runs locally and on CI for every Node version in the matrix.
- `publish.yml` accepts a `workflow_dispatch` with a `dry-run` boolean
  input so the publish workflow can be exercised end-to-end without
  pushing to npm.
- Disk-backed token cache (`omnilogic-token.json` in Homebridge's plugin
  persist path) so the plugin doesn't re-authenticate on every Homebridge
  restart. Stored with `0600` file permissions and bound to the configured
  username.
- `hideEquipmentIds` config option to suppress specific accessories without
  disabling whole categories.
- `disableLogs` config option for users who want a fully quiet plugin.
- Discovery is now retried with exponential backoff (5s → 5min) when the
  cloud is unreachable at startup, instead of failing the plugin permanently.
- Discovered equipment is logged at startup with system IDs so users can
  pick IDs to hide via `hideEquipmentIds`.
- Bug-report issue template (`.github/ISSUE_TEMPLATE/bug_report.yml`).

### Changed

- Extracted pure XML/SOAP helpers from `omnilogic-api.ts` into a new
  `xml-utils.ts` module. `OmniLogicApi` is now ~40% smaller and
  focused on transport + token state; the parsing logic is testable
  in isolation. No behaviour change for consumers.
- Collapsed five duplicated `try { setX(); refresh } catch { log; throw }`
  blocks across the accessory files into a single `BaseAccessory.runApiSet`
  helper.
- Pulled the 8-parameter "no schedule" trailing block out of three SET
  methods into a shared `NO_SCHEDULE` constant.
- ESLint rule `quotes` allows template literals (`avoidEscape` only
  covered double quotes).
- `engines.node` bumped to `^20.10.0 || ^22 || ^24`. Node 18 is no longer
  supported.
- Dev tooling: dropped `nodemon` in favour of `tsc --watch` + Node's own
  `--watch` flag, orchestrated by `concurrently`.
- Publish workflow uses `NPM_CONFIG_PROVENANCE` env var instead of the
  `--provenance` flag (functionally identical).
- README restructured to lead with troubleshooting and quick-start.

## [0.1.0] - Initial release

- TypeScript dynamic platform plugin for Hayward OmniLogic.
- SOAP/XML client for `HomeAutomationService.asmx` with redacted debug
  logs, nested-XML payload parsing, Status validation on SETs, transparent
  re-login on token expiry.
- Accessory handlers: Heater (Thermostat), variable-speed Filter (Fan),
  pumps/chlorinator (Switch), ColorLogic lights (Lightbulb), water
  temperature (Temperature Sensor).
- Per-accessory SET mutex and post-SET telemetry refresh for a responsive
  HomeKit experience.
- GitHub Actions CI on Node 18/20/22 (later moved to 20/22/24) and
  tag-driven npm publish workflow with provenance.

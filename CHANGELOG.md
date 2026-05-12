# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

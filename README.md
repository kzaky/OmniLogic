# homebridge-omnilogic-pool

A modern [Homebridge](https://homebridge.io) plugin for the
**Hayward OmniLogic** pool/spa controller.

Supports Node 20 / 22 / 24 and Homebridge 1.8+ / 2.0. Replaces the
unmaintained `homebridge-omnilogic` plugin which only ran on legacy
Node versions.

> **Status:** unofficial, community-built, not endorsed by Hayward.

## Troubleshooting first

Most setup problems fall into one of these:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `login failed (Status=…)` | Wrong credentials, or account doesn't have access to the site | Verify in the OmniLogic mobile app, then update `username`/`password` |
| Plugin loads but no accessories appear | MSP config response was empty | Enable `"debug": true`, restart, attach the redacted `GetMspConfigFile` log section to a GitHub issue |
| HomeKit shows the wrong on/off state | Telemetry attribute names differ for your firmware | Open an issue with the redacted `GetTelemetryData` response |
| Heater set rejected (`Status=…`) | Equipment is busy or unavailable on the controller | Wait for the controller to settle and retry |

Always run with `"debug": true` when filing a bug. Passwords and
session tokens are **redacted automatically** before logs are emitted.

## Install

```bash
npm install -g homebridge-omnilogic-pool
```

Or via Homebridge UI: search for **Hayward OmniLogic Pool**.

## Quick start (config.json)

The minimum viable config:

```json
{
  "platforms": [
    {
      "platform": "OmniLogicPool",
      "name": "OmniLogic Pool",
      "username": "you@example.com",
      "password": "your-omnilogic-password"
    }
  ]
}
```

That's it. The plugin discovers your Backyard, bodies of water, and
equipment automatically and exposes them as HomeKit accessories.

## Configuration reference

| Option | Default | Description |
| --- | --- | --- |
| `username` | — | OmniLogic account email (required) |
| `password` | — | OmniLogic account password (required) |
| `pollIntervalSeconds` | `30` | Telemetry poll cadence. Min `15`. Values below `30` may trigger Hayward rate limiting. |
| `temperatureUnits` | `F` | `F` or `C` — affects what HomeKit displays for heater setpoints. |
| `exposeHeaters` | `true` | Expose heaters as Thermostats. |
| `exposeLights` | `true` | Expose ColorLogic lights as Lightbulbs. |
| `exposePumps` | `true` | Expose filter and auxiliary pumps. |
| `exposeChlorinator` | `true` | Expose the chlorinator as a Switch. |
| `hideEquipmentIds` | `[]` | OmniLogic system IDs to hide from HomeKit. The IDs are logged at startup. |
| `debug` | `false` | Verbose SOAP request/response logging (auto-redacted). |
| `disableLogs` | `false` | Suppress every log line emitted by this plugin. |

## Supported equipment

| OmniLogic equipment | HomeKit service | Capabilities |
| --- | --- | --- |
| Heater | Thermostat | Off / Heat, target temperature |
| Variable-speed filter | Fan | On/off + rotation speed (% of max) |
| Auxiliary pump | Switch | On/off |
| Chlorinator | Switch | On/off (status only on some firmwares) |
| ColorLogic light | Lightbulb | On/off (remembers last show) |
| Body of water (water temp) | Temperature Sensor | Read-only |

## Authentication

Credentials are exchanged for a session token on first launch and the
token is cached at:

```
<homebridge persist path>/omnilogic-token.json
```

The cache file is written with `0600` permissions and bound to the
configured username — changing the username in `config.json`
invalidates the cache automatically. The token is refreshed
transparently when it expires or is rejected mid-session.

## Security notes

- Your OmniLogic credentials live in plain text in Homebridge's
  `config.json`. That's a Homebridge constraint, not a plugin one —
  protect the file the same way you would for any other Homebridge
  plugin.
- `"debug": true` is **safe to use**: `Password`, `Token`, `UserID`,
  and `UserId` fields are masked before any log line is emitted.
  Verify before sharing if you've configured custom log sinks.
- All API traffic uses HTTPS to `haywardomnilogic.com`. Certificate
  validation is enabled by default (axios default).

## Development

```bash
git clone https://github.com/kzaky/OmniLogic.git
cd OmniLogic
npm install
npm run build      # one-shot compile
npm run lint
npm run dev        # tsc --watch + node --watch homebridge -I -D
```

Source layout:

```
src/
  index.ts                   # Homebridge entrypoint
  platform.ts                # Dynamic platform: discovery, polling, log silencing
  omnilogic-api.ts           # SOAP/XML client (login, MSP, telemetry, set commands)
  token-store.ts             # Disk-backed token cache (mode 0600, atomic writes)
  settings.ts                # Constants
  types.ts                   # Config + accessory context types
  accessories/
    base-accessory.ts          # Per-accessory SET mutex + post-SET refresh hook
    heater-accessory.ts        # Thermostat
    light-accessory.ts         # Lightbulb (ColorLogic)
    switch-accessory.ts        # Generic on/off (pumps, chlorinator)
    filter-pump-accessory.ts   # Variable-speed Fan
    temperature-sensor-accessory.ts
```

## Releasing

The publish workflow (`.github/workflows/publish.yml`) triggers on
`v*.*.*` tags:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit to `main` and push.
3. `git tag v0.2.0 && git push origin v0.2.0`.
4. The workflow runs lint + build, verifies the tag matches the
   `package.json` version, then publishes to npm with provenance
   (`NPM_CONFIG_PROVENANCE=true`).

Required setup:

- A repository secret `NPM_TOKEN` (granular npm automation token with
  publish rights).
- A GitHub Environment named `npm-publish` bound to that secret. Add
  yourself as a required reviewer if you want manual approval on
  every release.

## API reference (for contributors)

The OmniLogic backend is a non-standard SOAP service at
`https://www.haywardomnilogic.com/HAAPI/HomeAutomation/HomeAutomationService.asmx`.
This plugin implements requests directly with `axios` +
`fast-xml-parser`. Methods used:

- `Login`
- `GetSiteList`
- `GetMspConfigFile`
- `GetTelemetryData`
- `SetHeaterEnable`
- `SetUIHeaterCmd`
- `SetUIEquipmentCmd`
- `SetUIFilterSpeedCmd`
- `SetStandAloneLightShow`

The MSP and telemetry responses wrap the meaningful payload as a
string-encoded XML fragment inside a `<Parameter dataType="XML">`
element. The client handles both the inline-element and string-XML
forms.

## Disclaimer

Unofficial. Not produced, endorsed, or supported by Hayward
Industries, Inc. "Hayward" and "OmniLogic" are trademarks of their
respective owners. Use at your own risk.

## License

[Apache-2.0](./LICENSE)

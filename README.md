# homebridge-omnilogic-pool

[![npm](https://img.shields.io/badge/homebridge-plugin-blue)](https://homebridge.io)

A modern [Homebridge](https://homebridge.io) plugin for the
**Hayward OmniLogic** pool/spa controller. Written in TypeScript, supports
Node 18 / 20 / 22 and Homebridge 1.8+ / 2.0.

> Replaces the unmaintained `homebridge-omnilogic` plugin which only ran
> on legacy Node versions.

## Features

- Auto-discovers your Backyard, bodies of water, and equipment via the
  OmniLogic cloud API (`GetMspConfigFile`).
- Polls live telemetry on a configurable interval.
- Exposes:
  - **Heater** as a HomeKit Thermostat (Off / Heat + setpoint)
  - **Variable-speed filter pump** as a Fan (on/off + speed %)
  - **Auxiliary pumps, chlorinator, relays** as Switches
  - **ColorLogic lights** as Lightbulbs (on/off; remembers last show)
  - **Water temperature** as a Temperature Sensor (per body of water)
- Dynamic platform — accessories are added/removed automatically when your
  OmniLogic config changes.
- Config UI schema for use with `homebridge-config-ui-x`.

## Installation

```bash
npm install -g homebridge-omnilogic-pool
```

Or via the Homebridge UI: search for **OmniLogic Pool** and install.

## Configuration

Add a platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "OmniLogicPool",
      "name": "OmniLogic Pool",
      "username": "you@example.com",
      "password": "your-omnilogic-password",
      "pollIntervalSeconds": 30,
      "temperatureUnits": "F",
      "exposeHeaters": true,
      "exposeLights": true,
      "exposePumps": true,
      "exposeChlorinator": true,
      "debug": false
    }
  ]
}
```

Use the same credentials you use in the **OmniLogic mobile app**.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `username` | — | OmniLogic account email |
| `password` | — | OmniLogic account password |
| `pollIntervalSeconds` | `30` | How often to refresh telemetry (10–600) |
| `temperatureUnits` | `F` | Display units (`F` or `C`) for thermostats |
| `exposeHeaters` | `true` | Expose heaters as Thermostats |
| `exposeLights` | `true` | Expose ColorLogic lights as Lightbulbs |
| `exposePumps` | `true` | Expose pumps/filters |
| `exposeChlorinator` | `true` | Expose chlorinator as a Switch |
| `debug` | `false` | Verbose SOAP request/response logging |

## Development

```bash
git clone https://github.com/kzaky/OmniLogic.git
cd OmniLogic
npm install
npm run build      # compile TypeScript
npm run watch      # rebuild + run a local Homebridge instance
npm run lint
```

The plugin is structured as:

```
src/
  index.ts                 # Homebridge entrypoint
  platform.ts              # Dynamic platform, discovery, polling
  omnilogic-api.ts         # SOAP/XML client for Hayward HAAPI
  settings.ts              # Constants
  types.ts                 # Config + accessory context types
  accessories/
    base-accessory.ts
    heater-accessory.ts          # Thermostat
    light-accessory.ts           # Lightbulb (ColorLogic)
    switch-accessory.ts          # Generic on/off (pumps, chlorinator)
    filter-pump-accessory.ts     # Variable-speed Fan
    temperature-sensor-accessory.ts
```

## API notes

The OmniLogic backend is a non-standard SOAP service at
`https://www.haywardomnilogic.com/HAAPI/HomeAutomation/HomeAutomationService.asmx`.
This plugin implements the requests directly with `axios` + `fast-xml-parser`
rather than pulling in a heavy SOAP client.

Implemented methods:

- `Login`
- `GetSiteList`
- `GetMspConfigFile`
- `GetTelemetryData`
- `SetHeaterEnable`
- `SetUIHeaterCmd`
- `SetUIEquipmentCmd`
- `SetUIFilterSpeedCmd`
- `SetStandAloneLightShow`

## Security notes

- Your OmniLogic credentials are stored **in plain text** in Homebridge's
  `config.json`. Lock down the file permissions on that directory the same
  way you would for any other Homebridge credentials.
- Debug logging (`"debug": true`) redacts the `Password` and `Token`
  fields before logs are emitted, so you can share logs safely when
  filing an issue. Confirm before sharing if you've enabled custom log
  destinations.
- All API traffic uses HTTPS to `haywardomnilogic.com`.

## Troubleshooting

1. Enable `"debug": true` and reload Homebridge.
2. Look for `OmniLogic Login response` / `OmniLogic GetMspConfigFile response`
   in the logs. Secrets are redacted automatically.
3. **`login failed (Status=...)`** — wrong username/password, or the
   account isn't permitted to access the site.
4. **No accessories appear** — the MSP config response was probably
   parsed empty. Open an issue and attach the redacted
   `GetMspConfigFile` response from your logs.
5. **Set command rejected** — the plugin logs `Status=<n>` from the
   controller. Hayward doesn't publish status codes, but non-zero
   typically means the equipment is busy or unavailable.

## Releasing

This repo ships a publish-on-tag workflow at
`.github/workflows/publish.yml`. To cut a release:

1. Bump `version` in `package.json`.
2. Commit and push to `main`.
3. Create a matching tag: `git tag v0.2.0 && git push origin v0.2.0`.
4. The workflow runs lint + build, verifies the tag matches the
   `package.json` version, and publishes to npm with provenance.

The workflow needs a repository secret named `NPM_TOKEN` (a granular
npm automation token with publish rights to this package) bound to a
GitHub Environment called `npm-publish`. The Environment gate lets you
require manual approval on every publish.

## Disclaimer

This is an **unofficial** plugin. It is not produced, endorsed, or supported
by Hayward Industries, Inc. "Hayward" and "OmniLogic" are trademarks of
their respective owners. Use at your own risk.

## License

[Apache-2.0](./LICENSE)

# Changelog

## 2.4.0 - Unreleased

### Added

- A page of its own for the settings in the Homebridge UI (`customUi`): a **manager** and a **setup wizard**. **The standard form is not replaced.** It stays available: with devices it starts hidden behind _Show standard form_ (it is shown when the wizard is skipped before the first device), edits made in either place show in the other, and it is shown again whenever the page cannot start. Nothing is written to `config.json` before the Save button of the settings window is pressed.
- The wizard opens when no device is configured, can be skipped, and is available from the manager later. The first version sets up the sensors that are only read (temperature, humidity, motion, contact, leak, smoke, occupancy) and a switch or a light that can also be controlled (a light can read and set its brightness). It sends the request, shows the response, lists the values found in it (JSONPath for JSON, XPath for XML), previews what HomeKit would get and checks the device with the validation that runs at startup.
- The manager lists the devices as cards with the errors and warnings that the log would show at startup, and can add (wizard or blank), copy, delete after a confirmation, reorder and edit them, with all settings in a form of their own, and edit the platform `defaults`. A device can be tested (_Test read_ shows the HTTP status, the response and every mapper step, following the fallback action; _Preview set_ shows the URL and body without sending anything), exported as JSON with secrets masked, and the accessories of a 1.x `config.json` can be imported. The accessories that HomeKit has cached are shown, with those that are no longer configured.
- English and Traditional Chinese, following the language of the Homebridge UI.
- The page takes its text colors from the page around it, so that it can be read in the dark theme of the Homebridge UI: Bootstrap's muted text, table, card and list colors are those of its light theme and were dark on dark there.
- `@homebridge/plugin-ui-utils` as a dependency, used by `homebridge-ui/server.js` only.
- The characteristic names in the form (the characteristic of an entry, and the optional characteristics) and the service of a device are fixed lists of the names that HomeKit has, so they are chosen and not typed. The lists are made from the HAP-NodeJS of Homebridge 1.8.5 (hap-nodejs 0.12.3) and of Homebridge 2.4.0 (@homebridge/hap-nodejs 2.2.2): a service has to be in both, because an unknown service keeps the device from loading, while a characteristic that one of them lacks only logs a warning. `Accessory Information` is not offered, since the plugin adds it itself. The lists are only for the form: a name that they lack still validates and works when it is written in the JSON config. `scripts/build-hap-names.js` regenerates them.
- The optional characteristics are rows with a dropdown each and a button that adds a row, so only the ones that were chosen take room, and the standard form offers only the characteristics that are optional on some service (123 of the 264). The form of the Homebridge UI would otherwise show the names as one checkbox each, and it has no dropdown for several choices.
- In the editor of the settings page, the characteristics on offer are those of the service of the device (and, for the additional services, of their services), and the optional ones are only the optional characteristics of the service. When the service is changed the form is shown again with the characteristics of the new one, keeping what was entered. A name that the device already uses stays on offer, and the standard form of the Homebridge UI keeps offering every name, since its schema cannot depend on the service.

### Fixed

- A characteristic that HomeKit names with a hyphen (`Current Heater-Cooler State`, `Target Heater-Cooler State`, `Current Humidifier-Dehumidifier State`, `Target Humidifier-Dehumidifier State`, `Wi-Fi ...`) could not be bound under the name without the hyphen, which is the name that the README and the 1.x conversion use (`CurrentHeaterCoolerState`): the device logged that the service had no such characteristic. Names are now matched by their letters and digits, so both spellings work, and `state.<name>` uses the spelling of the configuration. Checked with the HAP-NodeJS of Homebridge 1.8.5 and of Homebridge 2.4.0, which both had the problem.
- HAP-NodeJS renamed a few services (`BatteryService` is now `Battery`, `Relay` is `CloudRelay`, `Slat` is `Slats`, `CameraEventRecordingManagement` is `CameraRecordingManagement`, `TunneledBTLEAccessoryService` is `Tunnel`). Homebridge 2.x has only the new names, so a device with `"service": "BatteryService"`, as in the README example and in what the 1.x conversion writes, was reported as having an unknown service and did not load. The old names are now understood on every Homebridge version, and the README uses the new ones.
- `_bridge`, which Homebridge adds to the platform block of a child bridge, was reported as an unknown setting.

### Security

- Test requests come from the Homebridge host with the authentication and headers of the device. Tokens and header values given as `env:` or `file:` are read on the server and never reach the browser. When the Homebridge UI is set to no login (`"auth": "none"`), test requests are switched off. Only `http` and `https` URLs are tested.

### Changed

- The code that validates and builds a device from the settings is shared between the platform and the settings page (`src/prepare-device.js`), so the page reports what the plugin does.


## 2.3.1 - 2026-10-12

### Changed

- Homebridge 1.8.5 or newer is accepted (`engines.homebridge` is `^1.8.5 || ^2.0.0`), no longer only 2.4.0 or newer. 1.8.5 is the first Homebridge 1.x that supports Node.js 22. Tested on Homebridge 1.8.5 and 2.4.0.

## 2.3.0 - 2026-10-08

### Added

- `headers`: custom request headers, a list of `{ name, value }` in `defaults`, in a device and in a single action (API keys, `Content-Type`, `Authorization: Token ...`, ...). Values can be literal, `env:NAME` or `file:/path`, like a bearer token, and are never logged. The lists of the three levels are combined, and a header with the same name replaces the one from a wider level. A value that cannot be read makes the requests fail instead of going out without it. A wrong header name or a value with a line break keeps the device from loading.
- `statusFault`: with `true`, the `StatusFault` characteristic of every service that offers it shows a fault while a read of that service fails, and is cleared by the next successful read. HomeKit can be notified of it, unlike a read error. Services without it get a warning; a `StatusFault` that the configuration maps itself is left alone.
- The `number` mapper turns the input into a number, optionally rounded (`round`, 0 to 10), and treats anything else as `inconclusive`. It replaces the `isNaN(parseFloat(value)) ? "inconclusive" : parseFloat(value)` expression of the examples.
- The Homebridge UI form can edit the headers of the defaults, devices and actions, and `statusFault`.

### Changed

- Requests that differ only in their headers are no longer shared or cached together.

## 2.2.0 - 2026-10-08

### Added

- `additionalServices`: more HomeKit services on the same accessory, for example temperature and humidity next to a CO2 sensor, or a battery. Each entry has an `id`, a `service`, an optional `name`, and its own `characteristics` and `optionCharacteristic`. The `id` becomes the subtype of the service, so it identifies the service in HomeKit and must not change. The services share the authentication, polling, timeouts and cache of the device, and characteristics that read the same URL share one request.
- The values of a service are available as `state.<id>.<Characteristic>` in templates and expressions. The characteristics of the device keep `state.<Characteristic>`.
- The Homebridge UI form can edit additional services, including the mapper fields that depend on the type.

### Changed

- The startup log of a device counts the characteristics of all its services and mentions the additional services.
- The poll log and failure state name a characteristic of an additional service as `<id>.<Characteristic>`.
- A service with an unknown type makes the device fail to load before the cached accessory is touched, as for the service of the device.

## 2.1.0 - 2026-10-08

### Added

- `manufacturer`, `model` and `serialNumber` for a device (or in `defaults`), shown in the accessory information of HomeKit. The serial number does not change the identity of the accessory. The migration script carries them over from a 1.x accessory (1.1.3 reads them there); before it dropped them.
- The `scale` mapper converts a number from one range to another (`inputMin`, `inputMax`, `outputMin`, `outputMax`, optional `round` and `clamp`). Input that is not a number is `inconclusive`.

### Changed

- A poll that keeps failing is logged once, with a reminder every five minutes and a message when it recovers, instead of one line per poll. What HomeKit sees does not change.
- A _set_ whose mappers end in `inconclusive` (for example `scale` with a value that is not a number) fails before a request is sent. Before, the word `inconclusive` was sent as the value.
- A mapper that cannot be created (for example a `scale` without `inputMax`) is reported with the device, characteristic and action it belongs to.

## 2.0.0 - 2026-10-08

**This is a breaking release**: see [MIGRATION.md](MIGRATION.md) to convert a 1.x configuration.

### Added

- `HttpAdvancedPlatform`, a Dynamic Platform with one accessory per entry of `devices`. Accessories are restored from the Homebridge cache and keep their identity through the device name, or through an optional `id`, so renaming a device with an `id` does not create a new accessory.
- Platform `defaults` that every device inherits and can override.
- `config.schema.json` for the Homebridge UI. Every setting is described, so saving the form does not drop anything.
- Settings are validated at startup; a device with an error is reported and skipped, and keeps its cached accessory.
- `allowUnsafeEval` and the `script` mapper for configurations that need full JavaScript.
- A restricted expression language for `expression` mappers and `${...}` templates: arithmetic, comparisons, `?:`, `value`, `state`, `Math` functions and `toNumber`. It is parsed by the plugin and never reaches `eval`, so it is safe by default. Expressions are checked when a device loads.
- `MIGRATION.md`, and a platform `sample-config.json`.
- A `get` or `set` action can override the bearer token of its device.
- `scripts/migrate-config.js` converts a 1.x `config.json` (or a single accessory) to the platform format and reports what needs review.

### Changed

- Homebridge 2.4.0 or newer is required (`engines.homebridge`), the version this release is tested with. The package declares the `supports-hap` keyword for the Homebridge UI.
- The `license` in `package.json` is `Apache-2.0`, as in the `LICENSE` file (it said `ISC`). The package now lists its contributors, and the README has a license and credits section.
- An HTTP answer outside 2xx is an error (`HTTP 401 Unauthorized`): HomeKit shows the accessory as not responding and `resultOnError` applies. Before, the body of any answer was mapped, so an expired token or a failing API could show as a plausible value. Such answers are not retried and not cached.
- With polling, a failed poll (including an `inconclusive` result without a fallback) now makes HomeKit reads of that characteristic fail until a poll succeeds. Before, the last value (or 0 after a restart) was answered and the failure was only logged. The poll error log names the characteristic.
- `urls` with `getXxx` / `setXxx` keys became a `characteristics` list: `[{ "characteristic": "On", "get": {}, "set": {}, "props": {} }]`.
- Mappers are written flat (`{ "type": "regex", "regexp": "..." }`), and a static mapping is a list of `{ "from", "to" }` pairs.
- `state` in templates and expressions is keyed by characteristic name (`state.Brightness`).
- Characteristic handlers use `onGet` / `onSet`; failed requests are reported to HomeKit as communication errors.
- In the Homebridge UI form, _Defaults_, _Set action_, _Characteristic properties_ and _Fallback action_ start collapsed.
- Node.js 22 or newer is required. `jsonpath-plus` is updated to 11 and `xpath` to 0.0.35.
- `${...}` in URL and body templates uses the expression language; full JavaScript there needs `allowUnsafeEval`.
- The `eval` mapper became the `script` mapper.

### Removed

- The `HttpAdvancedAccessory` accessory and the `urls` configuration of 1.x.
- `uriCallsDelay`; `maxConcurrent: 1` runs the requests one at a time.
- `manufacturer`, `model` and `serialNumber`, which 1.1.3 added to the accessory, are not available in the platform yet.
- Digest authentication (already unavailable since 1.1.0).

## 1.1.3 - 2026-10-08

### Added

- `manufacturer`, `model` and `serialNumber` settings for the accessory information that HomeKit shows. Without them the values stay `Custom Manufacturer`, `HTTP Accessory Model` and `HTTP Accessory Serial Number`. The README example already listed `manufacturer` and `model`, but they were never read.

### Changed

- The `license` in `package.json` is `Apache-2.0`, as in the `LICENSE` file (it said `ISC`), and the package lists its author and contributors.

## 1.1.2 - 2026-10-07

### Fixed

- An accessory without a `service`, or with an unknown one, no longer stops Homebridge from starting. It is left out with an error in the log (`Accessory "X" has no "service" setting, it was not loaded.`) and the other accessories load normally.

## 1.1.1 - 2026-10-07

### Fixed

- The plugin failed to load on Node.js 18 because `jsonpath-plus` 11 requires a newer Node.js. It now uses `jsonpath-plus` 10.4, which supports Node.js 18.

## 1.1.0 - 2026-10-07

Settings of existing `config.json` files keep working. The plugin is still configured as an accessory; a notice in the log announces that 2.0.0 will switch to a Dynamic Platform.

### Added

- `bearerToken` can read the token from an environment variable (`env:NAME`) or a file (`file:/path`); whitespace is trimmed.
- Request settings: `timeout` (default 10000 ms), `retries` (reads only), `cacheTTL`, `maxConcurrent`.
- Identical in-flight read requests are sent once, and successful reads are cached for `cacheTTL` seconds (default `forceRefreshDelay`). A successful set clears the cache.
- Getter actions that issue the same request share one poll per `forceRefreshDelay`.

### Changed

- Requires Node.js 18 or newer and Homebridge 1.6 or newer.
- HTTP is done with the built-in `fetch`; the deprecated `request` and `polling-to-event` packages were removed.
- `xmldom` and `JSONPath` were replaced by `@xmldom/xmldom` and `jsonpath-plus`, and `xpath` was updated. JSONPath filter expressions run in the safe subset of `jsonpath-plus` instead of arbitrary JavaScript.
- `uriCallsDelay` is now the minimum gap between the start of two requests.
- The plugin is registered under its package name `homebridge-http-advanced-accessory-zyao`.
- The code was split into modules under `src/`; the accessory uses `updateValue` instead of an internal set-suppression flag.

### Fixed

- `StaticMapper` returned the input instead of a mapped value that is falsy (`0`, `""`).
- A getter whose response is inconclusive and has no fallback action now fails instead of never answering, and polling continues.
- A broken `${...}` template reports an error for the set request instead of throwing.
- The README no longer renders part of its content as a code block.

### Behavior differences

- No `Authorization` header is sent when neither a token nor a username/password is configured (it used to be an empty Basic header).
- With `"immediately": false`, Basic credentials are sent after a `401` response; HTTP Digest authentication is no longer supported.
- Getters without a configured action are no longer polled.
- An accessory whose `bearerToken` source cannot be read logs an error and fails its requests instead of falling back to Basic authentication.

## 1.0.0 - 2026-10-07

First release of this fork, published as `homebridge-http-advanced-accessory-zyao`. It is based on the original [homebridge-http-advanced-accessory](https://github.com/staromeste/homebridge-http-advanced-accessory) and adds one feature: Bearer Token authentication.

### Added

- `bearerToken`: when set, every request is sent with `Authorization: Bearer <token>`. It takes precedence over `username` and `password`; without it, HTTP Basic authentication works as before.

### Changed

- The package is renamed to `homebridge-http-advanced-accessory-zyao` and the README documents Bearer Token authentication.

# Changelog

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

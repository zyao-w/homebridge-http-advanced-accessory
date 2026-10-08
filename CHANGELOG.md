# Changelog

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

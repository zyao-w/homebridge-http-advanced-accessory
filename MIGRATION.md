# Migrating from 1.x to 2.0

2.0.0 replaces the `HttpAdvancedAccessory` accessory with the `HttpAdvancedPlatform` platform. One platform block describes all your devices. The old accessory is gone, so a 1.x configuration does not load any more and has to be converted. A script does most of the work.

Requirements: Node.js 22 or newer and Homebridge 1.6 or newer.

## 1. Convert the configuration

Make a backup of `config.json` first. Then run the migration script that ships with the plugin on a copy of the file:

```sh
node <plugin folder>/scripts/migrate-config.js config.json migrated.json
```

The plugin folder is `homebridge-http-advanced-accessory-zyao` inside the global `node_modules` (`npm root -g` shows where; in the Homebridge Docker image it is `/homebridge/node_modules`). The script

- turns every `HttpAdvancedAccessory` in `accessories` into a device of one `HttpAdvancedPlatform` block,
- leaves other plugins' accessories, platforms and settings untouched,
- never modifies the input file,
- prints what it could not convert as warnings.

Read every warning, see [What changed](#what-changed). The script also accepts a single accessory or a list of accessories instead of a whole `config.json`, and prints to the screen when no output file is given.

`migrated.json` contains the whole configuration with the new `platforms` entry. Accessories and platforms of other plugins are kept as they were, and the `HttpAdvancedAccessory` entries are removed from `accessories`.

## 2. Install the new config

Copy the result over `config.json`, or replace the parts by hand:

- The `HttpAdvancedPlatform` block belongs in the **top-level `platforms` list of `config.json`** (Homebridge UI: Settings > JSON Config). Do not paste it into the JSON editor of the plugin page; that editor edits one block of the old accessory and a block of the wrong kind leaves a broken accessory entry behind.
- Remove the old `HttpAdvancedAccessory` blocks from `accessories`.

Restart Homebridge and look at the log. A device that has a mistake is reported with the name of the setting and skipped; the others keep working.

> **The plugin page may look empty or stay on the old form.** The Homebridge UI remembers which kind of plugin this is for 24 hours, and Homebridge's restart does not clear it. After upgrading from 1.x, restart the Homebridge UI service (in Docker, restart the container) or wait a day. The plugin works either way.

## 3. HomeKit

Accessories of the old kind and platform accessories are different things for Homebridge, so HomeKit treats the migrated devices as new accessories. Expect to put them in their rooms again and to recreate the automations and scenes that used them, and to remove the old accessories that now show "No Response" in the Home app.

From now on an accessory is identified by its `name`, or by its optional `id`. Renaming a device that has no `id` creates a new accessory in HomeKit; give a device an `id` (once, now) if you may want to rename it later. Devices whose configuration has a mistake keep their accessory in HomeKit, so a typo does not make them disappear.

## What changed

### Configuration layout

| 1.x                                                             | 2.0                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessories: [{ "accessory": "HttpAdvancedAccessory", ... }]`  | `platforms: [{ "platform": "HttpAdvancedPlatform", "devices": [ ... ] }]`                                                                                           |
| `urls: { "getOn": {...}, "setOn": {...} }`                      | `characteristics: [{ "characteristic": "On", "get": {...}, "set": {...} }]`                                                                                         |
| `props` next to `urls`                                          | `props` inside the characteristic entry; only `format`, `unit`, `minValue`, `maxValue`, `minStep`, `validValues`, `validValueRanges`, `perms` and `maxLen` are kept |
| mapper `{ "type": "regex", "parameters": { "regexp": "..." } }` | `{ "type": "regex", "regexp": "..." }`                                                                                                                              |
| static mapper `"mapping": { "ARMED": "1" }`                     | `"mapping": [{ "from": "ARMED", "to": "1" }]`                                                                                                                       |
| `state.getOn` in expressions and templates                      | `state.On`, keyed by the characteristic name                                                                                                                        |
| settings repeated on every accessory                            | `defaults` of the platform, overridable per device                                                                                                                  |

The reasons are practical: the Homebridge UI can only show and save settings it can describe, and it drops dictionaries with names you choose (such as `urls`). Lists and fixed names can be edited in the UI without losing anything.

### Mappers and JavaScript

The `eval` mapper is gone. It is replaced by two mappers:

- `expression` runs the small expression language of the plugin: arithmetic, comparisons, `?:`, `value`, `state`, a few `Math` and number functions. It cannot call arbitrary code, so it is on by default. See [Expressions and scripts](README.md#expressions-and-scripts) for the list.
- `script` runs any JavaScript, like `eval` did. It needs `"allowUnsafeEval": true` on the device (or in `defaults`) and should only come from a configuration you trust.

The migration script tries each `eval` expression with the new language: if it fits, it becomes an `expression`; if not, it becomes a `script` and the script warns you that `allowUnsafeEval` is needed. The same check is made for the `${...}` parts of URLs and bodies: what does not fit is reported, and works again with `allowUnsafeEval`. Without the setting, a device that uses them is not loaded, and the log says which expression and where.

In a script, `self.state.getOn` is now `state.On` (the migration renames it for you).

**A script that parses JSON usually does not need to be one.** The typical `eval` of 1.x parses the response, picks a field, converts it to a number and maps it to a value. That is a `jpath` mapper followed by `expression` mappers, and it needs no `allowUnsafeEval`:

```json
"mappers": [
  { "type": "jpath", "jpath": "$.data.pm25" },
  { "type": "expression", "expression": "toNumber(value)" },
  { "type": "expression", "expression": "value <= 12 ? 1 : value <= 35 ? 2 : value <= 55 ? 3 : 4" }
]
```

A response that is not JSON, or a missing field, gives `toNumber(value)` = 0, as the usual `try { JSON.parse } catch` and `Number.isFinite` guards did. See the [air quality example](README.md#json-api-as-airqualitysensor-expression-mappers).

### Settings

| 1.x                                                           | 2.0                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `uriCallsDelay`                                               | removed. `maxConcurrent: 1` runs the requests one at a time, which is what the script sets when `uriCallsDelay` was used. |
| `manufacturer`, `model`                                       | not supported, dropped with a warning                                                                                     |
| an `inconclusive` action inside another `inconclusive` action | not supported: only one fallback level is allowed. The migration drops the deeper one with a warning.                     |
| Digest authentication                                         | not supported (since 1.1.0)                                                                                               |

New in 2.0: `id`, `defaults`, per-action `bearerToken`, `allowUnsafeEval`, validation of the whole configuration when Homebridge starts, the Homebridge UI form, and the `expression` and `script` mappers.

## Going back

Install 1.1.2 again (`npm install -g homebridge-http-advanced-accessory-zyao@1.1.2`) and put your backup of `config.json` back. The new accessories become "No Response" in HomeKit and the old ones return.

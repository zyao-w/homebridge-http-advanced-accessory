# homebridge http advanced accessory

Homebridge plugin that turns virtually any device with an HTTP API into HomeKit accessories. Each device is described in the configuration: which HomeKit service it is, which URLs to call to _read_ and _change_ every characteristic, and how to turn the responses into the values HomeKit expects.

This is a modified fork of the original [homebridge-http-advanced-accessory](https://github.com/staromeste/homebridge-http-advanced-accessory), maintained independently. It adds Bearer Token authentication, request caching and de-duplication, timeouts and retries, and (from 2.0.0) a Dynamic Platform with a Homebridge UI form.

> **Upgrading from 1.x?** 2.0.0 is a breaking change: the `HttpAdvancedAccessory` accessory was replaced by the `HttpAdvancedPlatform` platform. See [MIGRATION.md](MIGRATION.md); `scripts/migrate-config.js` converts your configuration for you.

## Installation

1. Install Homebridge (Node.js 22 or newer is required): `npm install -g homebridge`
2. Install this plugin: `npm install -g homebridge-http-advanced-accessory-zyao`
3. Configure it in the Homebridge UI (plugin page > Settings), or add the platform block below to the top-level `platforms` list of `config.json`. `sample-config.json` in this repository is a complete example.

## Features

- Configurable HTTP endpoints for reading and writing every characteristic, with GET or POST (and PUT, PATCH, DELETE), parameters in the URL or in the body
- Bearer Token and HTTP Basic authentication; a token can come from an environment variable or a file
- Chains of mappers (regular expression, XPath, JSONPath, static table, expression, script) that turn a response into a HomeKit value, and a fallback action when a response is inconclusive
- URL and body templates that use the value being set and the current state of the other characteristics
- Interval polling, so HomeKit notifications work even when the device is changed by something else
- One shared request for characteristics that read the same URL, a short response cache, request timeouts, read retries and a cap on concurrent requests
- Accessories keep their identity in HomeKit when the configuration is edited

## Configuration

A platform has an optional list of `defaults` that every device inherits, and a list of `devices`:

```json
{
	"platforms": [
		{
			"platform": "HttpAdvancedPlatform",
			"name": "HTTP Advanced",
			"defaults": { "forceRefreshDelay": 5, "timeout": 5000, "bearerToken": "env:MY_API_TOKEN" },
			"devices": [
				{
					"name": "Terrace Sensor",
					"service": "ContactSensor",
					"characteristics": [
						{
							"characteristic": "ContactSensorState",
							"get": {
								"url": "http://remoteserver/xml/zones/zonesStatus48IP.xml",
								"mappers": [
									{ "type": "xpath", "xpath": "//status[1]/text()" },
									{
										"type": "static",
										"mapping": [
											{ "from": "ALARM", "to": "1" },
											{ "from": "NORMAL", "to": "0" }
										]
									}
								]
							}
						}
					]
				}
			]
		}
	]
}
```

The `platform` block belongs in the top-level `platforms` list of `config.json`. Settings are validated when Homebridge starts; a device with a mistake is reported in the log with the name of the setting and is skipped, the other devices keep working. In the Homebridge UI form, the sections that are rarely edited (_Defaults_, _Set action_, _Characteristic properties_, _Fallback action_) start collapsed, and an HTTP method of _None_ means GET.

### Platform settings

| Setting    | Description                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform` | Always `HttpAdvancedPlatform`.                                                                                                                                                 |
| `name`     | Name of the platform in the Homebridge log.                                                                                                                                    |
| `defaults` | Any of the [device settings](#device-settings) except `name`, `id`, `service`, `optionCharacteristic` and `characteristics`; a device that sets the same setting overrides it. |
| `devices`  | The list of [devices](#device-settings).                                                                                                                                       |

### Device settings

| Setting                | Description                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Name of the accessory in HomeKit. Required.                                                                                                                                                 |
| `id`                   | Optional stable identifier. By default the accessory is identified by its `name`, so renaming it creates a new accessory in HomeKit; with an `id` it can be renamed freely. Must be unique. |
| `service`              | The HomeKit service, for example `Switch`, `Lightbulb` or `TemperatureSensor`. See [Supported services](#supported-services). Required.                                                     |
| `optionCharacteristic` | List of optional characteristics of the service that you want to expose, for example `["Brightness"]`.                                                                                      |
| `characteristics`      | What to read and write, see [Characteristics](#characteristics).                                                                                                                            |
| `forceRefreshDelay`    | Polling interval in seconds. Defaults to 0, which disables polling.                                                                                                                         |
| `setterDelay`          | Milliseconds to wait before sending a _set_ request; if more arrive meanwhile, only the last one is sent. HomeKit gets its answer at once. Defaults to 0.                                   |
| `username`, `password` | HTTP Basic credentials, see [Authentication](#authentication).                                                                                                                              |
| `bearerToken`          | Bearer token, see [Authentication](#authentication).                                                                                                                                        |
| `immediately`          | With `false`, Basic credentials are only sent after the server answered `401`. Defaults to `true`.                                                                                          |
| `timeout`              | Milliseconds after which a request is aborted. Defaults to 10000; 0 disables it.                                                                                                            |
| `retries`              | Extra attempts for _read_ requests that fail with a network error or a timeout. HTTP error statuses are not retried and set requests never are. Defaults to 0.                              |
| `cacheTTL`             | Seconds a successful read response is reused. Defaults to the value of `forceRefreshDelay`, so it is off unless polling is on. Any set request clears the cache.                            |
| `maxConcurrent`        | Maximum simultaneous HTTP requests of the device, for devices that cannot take many at once. `1` runs them one after the other. Defaults to 0, unlimited.                                   |
| `allowUnsafeEval`      | Allows `script` mappers and JavaScript in `${...}` templates, see [Expressions and scripts](#expressions-and-scripts). Defaults to `false`.                                                 |
| `debug`                | Logs every request and the whole mapping process.                                                                                                                                           |

Read requests with the same method, URL, body and credentials that are in flight at the same time are sent only once. With polling on, all characteristics that read the same request share one poll.

### Characteristics

`characteristics` is a list with one entry per HomeKit characteristic of the service:

```json
{
	"characteristic": "TargetTemperature",
	"get": { "url": "http://remoteserver/temperature" },
	"set": { "url": "http://remoteserver/setTemperature?stemp={value}" },
	"props": { "minValue": 16, "maxValue": 30, "minStep": 0.5 }
}
```

- `characteristic` is the name of the HomeKit characteristic. Names are matched without spaces, so `On`, `CurrentTemperature` and `Current Temperature` are the same. The full list is in [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS).
- `get` is the action that reads the value (see [Actions](#actions)). Without it the characteristic is not polled and answers with its last known value.
- `set` is the action that writes the value. Without it a value set from HomeKit is accepted, but nothing is sent.
- `props` overrides properties of the characteristic: `format`, `unit`, `minValue`, `maxValue`, `minStep`, `validValues`, `validValueRanges`, `perms` and `maxLen`.

## Actions

An action describes one HTTP request. The same settings are used for `get` and `set`:

| Setting         | Description                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`           | The URL to call. Required. In a _set_ action it can contain `{value}` and `${...}` expressions, see [Templates](#templates).                                                        |
| `httpMethod`    | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. Defaults to `GET`.                                                                                                                       |
| `body`          | The body of the request. In a _set_ action it is a template as well.                                                                                                                |
| `mappers`       | A chain of [mappers](#mappers). For a _get_ it turns the response into the value for HomeKit; for a _set_ it turns the value from HomeKit into what the device expects (`{value}`). |
| `resultOnError` | The value to use when the request fails (see below), instead of reporting an error to HomeKit. Useful for health checks, where "cannot connect" is a valid state.                   |
| `bearerToken`   | A token for this action only; it replaces the device token.                                                                                                                         |
| `inconclusive`  | Another _get_ action to run when the mapper chain ends with the word `inconclusive`. It cannot have an `inconclusive` action of its own.                                            |

When a request fails and there is no `resultOnError`, HomeKit shows the accessory as not responding and the reason is written to the Homebridge log. A request fails when the device cannot be reached, when it times out, or when it answers with a status outside 2xx (`HTTP 401 Unauthorized`, `HTTP 503 Service Unavailable`, ...); the body of such an answer is not mapped.

With polling (`forceRefreshDelay`), the plugin remembers that the last poll of a characteristic failed (or ended in `inconclusive` without a fallback). The next time HomeKit reads the characteristic it gets the error, so the Home app shows "No Response"; the first successful poll clears it. HomeKit cannot be told about an error at the moment it happens, so the Home app may keep showing the last value until it reads again, for example when you open it or pull to refresh. Every failed poll is written to the Homebridge log (`Poller for <characteristic> errored: ...`).

### Templates

The URL and the body of a _set_ action are templates. `{value}` is replaced with the value after the mappers have run. Inside `${...}` you can write an [expression](#expressions-and-scripts) that sees two variables:

- `value`: the value HomeKit wants to set, before the mappers
- `state`: the last known values of the characteristics of the device, by characteristic name, for example `state.TargetTemperature`

For example, setting `Active` may also have to send the target temperature in Fahrenheit:

```json
{
	"characteristic": "Active",
	"set": {
		"url": "http://remoteserver/setActive?${value}&stemp=${state.TargetTemperature * 9 / 5 + 32}"
	}
}
```

A characteristic that was never read or set is `undefined` in `state`.

## Mappers

A mapper chain boils the response of a request down to the single value HomeKit expects. The mappers run in order and the result of a mapper is the input of the next one. Each mapper is an object with a `type` and its own settings.

### Static mapper

Looks the input up in a table. It is great for turning words such as `ARMED` into the numbers HomeKit uses. An input that is not in the table is returned as it is.

```json
{
	"type": "static",
	"mapping": [
		{ "from": "STAY", "to": "0" },
		{ "from": "AWAY", "to": "1" }
	]
}
```

### Regular expression mapper

Runs a regular expression on the input and returns a capture group. If it does not match, the input is returned unchanged.

```json
{ "type": "regex", "regexp": "^The system is currently (ARMED|DISARMED), yo!$", "capture": "1" }
```

For `The system is currently ARMED, yo!` the result is `ARMED`.

### XPath mapper

Extracts data from an XML document. Select text nodes (`/text()`), not whole elements. `index` picks one result when the path selects several.

```json
{ "type": "xpath", "xpath": "//partition[3]/text()", "index": 0 }
```

For `<partitionsStatus><partition>ARMED</partition><partition>ARMED</partition><partition>ARMED_IMMEDIATE</partition></partitionsStatus>` the result is `ARMED_IMMEDIATE`.

### JSONPath mapper

Extracts data from a JSON document with [jsonpath-plus](https://www.npmjs.com/package/jsonpath-plus), see its documentation for the syntax. Filters such as `$..[?(@.n>1)]` run in its safe subset. Select values or arrays, not whole objects. `index` picks one result when the path selects several.

```json
{ "type": "jpath", "jpath": "$.partitionsStatus.partition[2]", "index": 0 }
```

### Expression mapper

Computes the value with an [expression](#expressions-and-scripts).

```json
{ "type": "expression", "expression": "value === \"OK\" ? 1 : 0" }
```

If the input is `OK` the result is `1`, for anything else `0`.

### Script mapper

Runs JavaScript. It needs `allowUnsafeEval`, see [Expressions and scripts](#expressions-and-scripts).

```json
{ "type": "script", "script": "const n = parseFloat(value); Number.isFinite(n) ? Math.round(n) : state.Target" }
```

The value of the last expression is the result. A script sees `value`, `state` and `self` (with `self.state`).

### Unexpected responses

A response with status 2xx that does not contain what the mappers expect is not an error by itself. Take care that it does not turn into a plausible value:

- A mapper chain that ends with the word `inconclusive` means "no usable answer". The `inconclusive` action of a _get_ runs; without one the request fails, HomeKit shows the accessory as not responding and the log says `Inconclusive response and no fallback action`.
- The `jpath` mapper returns `inconclusive` when the response is not a JSON object. When the path does not exist it returns `[]` (an empty list, as text).
- Mappers after it receive that text. `toNumber(value)` turns both into 0, so a broken API can show as "0 ppm" or "air quality excellent". To turn them into an error, end a numeric chain with an expression that returns `inconclusive` for anything that is not a number:

```json
{ "type": "expression", "expression": "isNaN(parseFloat(value)) ? \"inconclusive\" : parseFloat(value)" }
```

An answer with a status outside 2xx never gets that far: it is an error before the mappers run, see [Actions](#actions). If your device answers with such a status and the body is meaningful (for example `404` meaning "off"), map it with `resultOnError` instead.

## Expressions and scripts

`expression` mappers and `${...}` templates use a small expression language. It is parsed by the plugin, never handed to JavaScript's `eval`, so a configuration cannot run arbitrary code with it. It offers:

- Numbers, strings in `'...'` or `"..."`, `true`, `false`, `null`, `undefined`
- The variables `value` and `state` (`state.On`, `state["Current Temperature"]`); reading a property that does not exist gives `undefined`, `.length` works on strings and arrays
- Operators `+ - * / %`, comparisons `< > <= >= == != === !==`, `&& || ??`, `!`, unary `-` and `+`, `condition ? a : b` and parentheses
- `Math.abs`, `ceil`, `floor`, `round`, `trunc`, `sign`, `min`, `max`, `pow`, `sqrt`, `log`, `log10`, `exp`, and `Math.PI` and `Math.E`
- `parseInt`, `parseFloat`, `Number`, `String`, `Boolean`, `isNaN`, `isFinite`, and `toNumber(x, fallback)`, which is `parseFloat` that returns `fallback` (default 0) instead of `NaN`

Everything else (method calls such as `value.toFixed(1)`, assignments, statements, arrow functions, `JSON`, `Date`, ...) is rejected when Homebridge starts, with the position of the problem in the log. For those you need a **script** mapper, or JavaScript in a `${...}` template. Both run with the full privileges of Homebridge, so they must be enabled explicitly with `"allowUnsafeEval": true` (on the device or in `defaults`) and should only come from a configuration you trust. Without the setting a device that uses them is not loaded.

## Authentication

Two methods are supported:

1. **Bearer Token**: set `bearerToken` and the plugin sends `Authorization: Bearer <token>`.
2. **HTTP Basic**: set `username` and `password`. They are used when no `bearerToken` is set. If nothing is set, no `Authorization` header is sent.

If both are configured, the Bearer token wins. Basic credentials are sent with every request; with `"immediately": false` they are only sent after the server answers `401` (HTTP Digest authentication is not supported).

To keep a token out of `config.json`, `bearerToken` can reference an environment variable or a file:

| Value                   | Source                                                    |
| ----------------------- | --------------------------------------------------------- |
| `"abc123"`              | Literal token                                             |
| `"env:MY_TOKEN"`        | Environment variable `MY_TOKEN`                           |
| `"file:/path/to/token"` | Content of the file (whitespace and newlines are trimmed) |

Leading and trailing whitespace is always trimmed. If the environment variable or the file cannot be read, an error is logged and the requests fail; they do not fall back to Basic authentication. The `bearerToken` of an action overrides the one of the device.

## Supported services

AccessoryInformation
AirQualitySensor
BatteryService
BridgeConfiguration
BridgingState
CameraControl
CameraRTPStreamManagement
CarbonDioxideSensor
CarbonMonoxideSensor
ContactSensor
Door
Doorbell
Fan
GarageDoorOpener
HumiditySensor
LeakSensor
LightSensor
Lightbulb
LockManagement
LockMechanism
Microphone
MotionSensor
OccupancySensor
Outlet
Pairing
ProtocolInformation
Relay
SecuritySystem
SmokeSensor
Speaker
StatefulProgrammableSwitch
StatelessProgrammableSwitch
Switch
TemperatureSensor
Thermostat
TimeInformation
TunneledBTLEAccessoryService
Window
WindowCovering

Any service that HAP-NodeJS defines can be used by its name.

## Configuration Examples

Each example is one entry of the `devices` list.

### Bearer token and JSONPath: CO2 sensor

```json
{
	"name": "CO2 Sensor",
	"service": "CarbonDioxideSensor",
	"bearerToken": "YOUR_BEARER_TOKEN",
	"characteristics": [
		{
			"characteristic": "CarbonDioxideLevel",
			"get": {
				"url": "https://example.com/api/",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$.data.co2"
					}
				]
			}
		}
	]
}
```

### JSON API as AirQualitySensor: expression mappers

A `jpath` mapper picks a field out of the JSON response and `expression` mappers turn it into a number and then into the HomeKit air quality level. No script and no `allowUnsafeEval` are needed. The first expression returns `inconclusive` when the field is missing, is not a number, or the response is not JSON, so a broken API shows as not responding and not as "air quality excellent" (see [Unexpected responses](#unexpected-responses)).

```json
{
	"name": "Air Quality Sensor",
	"service": "AirQualitySensor",
	"optionCharacteristic": ["PM2.5Density", "VOCDensity"],
	"forceRefreshDelay": 30,
	"bearerToken": "env:AIR_API_TOKEN",
	"characteristics": [
		{
			"characteristic": "AirQuality",
			"get": {
				"url": "https://example.com/api/air/",
				"mappers": [
					{ "type": "jpath", "jpath": "$.data.pm25" },
					{
						"type": "expression",
						"expression": "isNaN(parseFloat(value)) ? \"inconclusive\" : value <= 12 ? 1 : value <= 35 ? 2 : value <= 55 ? 3 : value <= 150 ? 4 : 5"
					}
				]
			}
		},
		{
			"characteristic": "PM2.5Density",
			"get": {
				"url": "https://example.com/api/air/",
				"mappers": [
					{ "type": "jpath", "jpath": "$.data.pm25" },
					{ "type": "expression", "expression": "isNaN(parseFloat(value)) ? \"inconclusive\" : parseFloat(value)" }
				]
			}
		},
		{
			"characteristic": "VOCDensity",
			"get": {
				"url": "https://example.com/api/air/",
				"mappers": [
					{ "type": "jpath", "jpath": "$.data.tvoc" },
					{ "type": "expression", "expression": "isNaN(parseFloat(value)) ? \"inconclusive\" : parseFloat(value)" }
				]
			}
		}
	]
}
```

The three characteristics read the same URL, so the plugin sends one request for all of them.

### Bticino "Nuovo antifurto filare"

A Bticino (BT-4200, 4201, 4202) as a HomeKit SecuritySystem. It uses an inconclusive fallback and a setter delay.

```json
{
	"name": "Btcino Security",
	"service": "SecuritySystem",
	"forceRefreshDelay": 5,
	"username": "admin",
	"password": "admin",
	"characteristics": [
		{
			"characteristic": "SecuritySystemTargetState",
			"get": {
				"url": "http://remoteserver/xml/state/virtualKeypad.xml",
				"mappers": [
					{
						"type": "xpath",
						"xpath": "//generic/text()"
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "0",
								"to": "3"
							},
							{
								"from": "1",
								"to": "1"
							},
							{
								"from": "2",
								"to": "2"
							},
							{
								"from": "3",
								"to": "0"
							}
						]
					}
				]
			},
			"set": {
				"url": "http://remoteserver/xml/cmd/cmdOk.xml?cmd=setMacro&macroId={value}&redirectPage=/xml/cmd/cmdError.xml",
				"mappers": [
					{
						"type": "static",
						"mapping": [
							{
								"from": "0",
								"to": "3"
							},
							{
								"from": "1",
								"to": "1"
							},
							{
								"from": "2",
								"to": "2"
							},
							{
								"from": "3",
								"to": "0"
							}
						]
					}
				]
			}
		},
		{
			"characteristic": "SecuritySystemCurrentState",
			"get": {
				"url": "http://remoteserver/xml/partitions/partitionsStatus48IP.xml",
				"mappers": [
					{
						"type": "regex",
						"regexp": "(ALARM)",
						"capture": "1"
					},
					{
						"type": "regex",
						"regexp": ">(ARMED)",
						"capture": "1"
					},
					{
						"type": "regex",
						"regexp": "(DISARMED)",
						"capture": "1"
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "ALARM",
								"to": "4"
							},
							{
								"from": "ARMED",
								"to": "inconclusive"
							},
							{
								"from": "DISARMED",
								"to": "3"
							}
						]
					}
				],
				"inconclusive": {
					"url": "http://remoteserver/xml/state/virtualKeypad.xml",
					"mappers": [
						{
							"type": "xpath",
							"xpath": "//generic/text()"
						},
						{
							"type": "static",
							"mapping": [
								{
									"from": "0",
									"to": "3"
								},
								{
									"from": "1",
									"to": "1"
								},
								{
									"from": "2",
									"to": "2"
								},
								{
									"from": "3",
									"to": "0"
								}
							]
						}
					]
				}
			}
		}
	]
}
```

### Bticino "Nuovo antifurto filare" zones as ContactSensor

```json
{
	"name": "Terrace Sensor",
	"service": "ContactSensor",
	"forceRefreshDelay": 5,
	"username": "admin",
	"password": "admin",
	"characteristics": [
		{
			"characteristic": "ContactSensorState",
			"get": {
				"url": "http://remoteserver/xml/zones/zonesStatus48IP.xml",
				"mappers": [
					{
						"type": "xpath",
						"xpath": "//status[1]/text()"
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "ALARM",
								"to": "1"
							},
							{
								"from": "NORMAL",
								"to": "0"
							}
						]
					}
				]
			}
		}
	]
}
```

### Daikin as HeaterCooler

This is still incomplete, but the unofficial [Daikin documentation](https://github.com/ael-code/daikin-control) can help you complete it.

```json
{
	"name": "Condizionatore Soggiorno",
	"service": "HeaterCooler",
	"forceRefreshDelay": 5,
	"characteristics": [
		{
			"characteristic": "CurrentHeaterCoolerState",
			"get": {
				"url": "http://192.168.x.x/aircon/get_control_info",
				"mappers": [
					{
						"type": "regex",
						"regexp": "(pow=0)",
						"capture": "1"
					},
					{
						"type": "regex",
						"regexp": "mode=(\\d)",
						"capture": "1"
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "3",
								"to": "3"
							},
							{
								"from": "4",
								"to": "2"
							},
							{
								"from": "pow=0",
								"to": "0"
							}
						]
					}
				]
			}
		},
		{
			"characteristic": "TargetHeaterCoolerState",
			"get": {
				"url": "http://192.168.x.x/aircon/get_control_info",
				"mappers": [
					{
						"type": "regex",
						"regexp": "(pow=0)",
						"capture": "1"
					},
					{
						"type": "regex",
						"regexp": "mode=(\\d)",
						"capture": "1"
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "0",
								"to": "3"
							},
							{
								"from": "1",
								"to": "3"
							},
							{
								"from": "2",
								"to": "3"
							},
							{
								"from": "3",
								"to": "3"
							},
							{
								"from": "4",
								"to": "2"
							},
							{
								"from": "7",
								"to": "3"
							},
							{
								"from": "pow=0",
								"to": "0"
							}
						]
					}
				]
			},
			"set": {
				"url": "http://192.168.x.x/aircon/set_control_info/{value}",
				"mappers": [
					{
						"type": "static",
						"mapping": [
							{
								"from": "0",
								"to": "?mode=0"
							},
							{
								"from": "1",
								"to": "?mode=4"
							},
							{
								"from": "2",
								"to": "?mode=3"
							}
						]
					}
				]
			}
		},
		{
			"characteristic": "Active",
			"get": {
				"url": "http://192.168.x.x/aircon/get_control_info",
				"mappers": [
					{
						"type": "regex",
						"regexp": "pow=(\\d)",
						"capture": "1"
					}
				]
			},
			"set": {
				"url": "http://192.168.x.x/aircon/set_control_info/{value}",
				"mappers": [
					{
						"type": "static",
						"mapping": [
							{
								"from": "0",
								"to": "?pow=0"
							},
							{
								"from": "1",
								"to": "?pow=1"
							}
						]
					}
				]
			}
		}
	]
}
```

### Yamaha Musiccast WX-010 as Switch

```json
{
	"name": "Bedroom speaker",
	"service": "Switch",
	"forceRefreshDelay": 5,
	"characteristics": [
		{
			"characteristic": "On",
			"get": {
				"url": "http://192.168.x.x/YamahaExtendedControl/v1/main/getStatus",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$..power",
						"index": 0
					},
					{
						"type": "static",
						"mapping": [
							{
								"from": "on",
								"to": "1"
							},
							{
								"from": "standby",
								"to": "0"
							}
						]
					}
				]
			},
			"set": {
				"url": "http://192.168.x.x/YamahaExtendedControl/v1/main/setPower?power=${value==1?\"on\":\"standby\"}"
			}
		}
	]
}
```

### Generic Web API as Lightbulb

```json
{
	"name": "Pool Light",
	"service": "Lightbulb",
	"optionCharacteristic": ["Hue", "Saturation", "Brightness"],
	"characteristics": [
		{
			"characteristic": "On",
			"set": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22pool%20i%20{value}%22%7D",
				"mappers": [
					{
						"type": "static",
						"mapping": [
							{
								"from": "true",
								"to": "on"
							},
							{
								"from": "false",
								"to": "off"
							}
						]
					}
				]
			},
			"get": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22update%20pool-on%22%7D",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$.u",
						"index": 0
					}
				]
			}
		},
		{
			"characteristic": "Hue",
			"set": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22pool%20hue%20{value}%22%7D",
				"mappers": []
			},
			"get": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22value%20pool-h%22%7D",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$.u",
						"index": 0
					}
				]
			}
		},
		{
			"characteristic": "Saturation",
			"set": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22pool%20saturation%20{value}%22%7D",
				"mappers": []
			},
			"get": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22value%20pool-s%22%7D",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$.u",
						"index": 0
					}
				]
			}
		},
		{
			"characteristic": "Brightness",
			"set": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22pool%20brightness%20{value}%22%7D",
				"mappers": []
			},
			"get": {
				"url": "http://127.0.0.1/control.php",
				"httpMethod": "POST",
				"body": "%7B%22c%22%3A%22value%20pool-b%22%7D",
				"mappers": [
					{
						"type": "jpath",
						"jpath": "$.u",
						"index": 0
					}
				]
			}
		}
	]
}
```

## Plugin Development

To try the plugin from a checkout, install Homebridge, check out this repository and run:

```sh
homebridge --debug --user-storage-path .homebridge-dev --plugin-path ./
```

The tests run with `npm test`; `npm run lint` and `npm run format:check` are checked in CI. `config.schema.json` is generated from `src/schema.js` by `npm run build:schema`.

## License and credits

This plugin is licensed under the [Apache License 2.0](LICENSE).

It is a modified fork of [staromeste/homebridge-http-advanced-accessory](https://github.com/staromeste/homebridge-http-advanced-accessory), whose package metadata names tasict as its author. The original copyright and license are retained, and the full history of the original authors is kept in this repository's git log.

- Original work: tasict and staromeste, with the contributors listed in the git history.
- This fork: maintained by [zyao-w](https://github.com/zyao-w), who is responsible for the changes below.

Main changes in this fork, as required by section 4 of the license. [CHANGELOG.md](CHANGELOG.md) has the details:

- 1.1.x: refactoring into modules, an HTTP layer on the built-in `fetch` with request sharing, caching, timeouts and retries, Bearer Token authentication, and dependency updates.
- 2.0.0: the `HttpAdvancedPlatform` Dynamic Platform and Homebridge UI form, validated configuration, the restricted expression language and `script` mapper, HTTP errors, and the removal of the 1.x accessory (see [MIGRATION.md](MIGRATION.md)).

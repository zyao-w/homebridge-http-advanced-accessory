const { PLATFORM_NAME } = require("./constants.js");
const { HEADER_NAME } = require("./http/headers.js");
const { CHARACTERISTICS, SERVICES } = require("./hap-names.js");

// The Homebridge UI form generator cannot render objects with user-defined keys and drops what the schema
// does not describe when the form is saved, so everything below is an object with fixed properties or an array.
// It must also avoid `required` and `default` inside array items: the form shows a blank first item.

const text = (title, extra = {}) => ({ title, type: "string", ...extra });
const number = (title, extra = {}) => ({ title, type: "number", minimum: 0, ...extra });
const integer = (title, extra = {}) => ({ title, type: "integer", minimum: 0, ...extra });
const signed = (title, extra = {}) => ({ title, type: "number", ...extra });
const bool = (title, extra = {}) => ({ title, type: "boolean", ...extra });
// Fixed lists in the form. They are only for the form: the validation does not use them (see validate.js), so a name
// that a list lacks still works when it is written in the JSON config. The form of the plugin offers every name; the
// custom UI passes a shorter list of characteristics, for the service of the device that it edits.
const SERVICE_NAMES = Object.keys(SERVICES).sort((a, b) => a.localeCompare(b, "en"));
// What can be listed as an optional characteristic of some service; the others are always there or not offered at all
const OPTIONAL_CHARACTERISTICS = [...new Set(Object.values(SERVICES).flatMap((service) => service.optional))].sort(
	(a, b) => a.localeCompare(b, "en")
);
const characteristicName = (title, extra = {}, names = CHARACTERISTICS) => ({
	title,
	type: "string",
	enum: names,
	...extra,
});
const serviceName = (title, extra = {}) => ({ title, type: "string", enum: SERVICE_NAMES, ...extra });

/**
 * The list of the optional characteristics to expose, as rows with a dropdown each and a button that adds a row, so
 * that only the ones that were chosen take room. The form would show an array of names from a list as a group of
 * checkboxes, one for each name on offer, unless the array is said to be an array; it has no dropdown for several
 * choices. A service that has no optional characteristics gets a list that cannot be added to, because a form cannot
 * offer a choice among nothing.
 */
function optionCharacteristics(description, names = OPTIONAL_CHARACTERISTICS) {
	const none = names.length === 0;
	return {
		title: "Optional characteristics",
		type: "array",
		description: none ? "This service has no optional characteristics." : description,
		uniqueItems: true,
		...(none ? { maxItems: 0 } : { "x-schema-form": { type: "array" } }),
		items: none ? { title: "Characteristic", type: "string" } : characteristicName("Characteristic", {}, names),
	};
}
const secret = (title, extra = {}) =>
	text(title, { widget: "password", "x-schema-form": { type: "password" }, ...extra });
const choice = (title, values, extra = {}) => ({
	title,
	type: "string",
	oneOf: values.map(([value, label]) => ({ title: label, enum: [value] })),
	...extra,
});
/** Rendered as a section that starts closed, for parts of the form that are rarely edited. */
const collapsed = { "x-schema-form": { type: "fieldset", expandable: true, expanded: false } };

const object = (properties, extra = {}) => ({ type: "object", properties, additionalProperties: false, ...extra });

const TOKEN_HELP = "A literal token, env:NAME for an environment variable, or file:/path/to/token.";

/** A list of { name, value } because the form cannot edit an object with names that the user chooses. */
function headersList(title, intro) {
	return {
		title,
		type: "array",
		description: `${intro}A header with the same name replaces the one from a wider level; Authorization replaces the one the plugin computes.`,
		items: {
			...object({
				name: text("Name", {
					placeholder: "X-API-Key",
					pattern: HEADER_NAME.source,
				}),
				value: secret("Value", {
					description: "A literal value, env:NAME for an environment variable, or file:/path/to/value.",
				}),
			}),
			title: "Header",
		},
	};
}

function settings() {
	return {
		headers: headersList("Headers", "Sent with every request, for example X-API-Key. "),
		manufacturer: text("Manufacturer", {
			placeholder: "Custom Manufacturer",
			description: "Shown in the accessory information of HomeKit.",
		}),
		model: text("Model", { placeholder: "HTTP Accessory Model" }),
		serialNumber: text("Serial number", {
			placeholder: "HTTP Accessory Serial Number",
			description: "Does not change the HomeKit identity of the accessory.",
		}),
		forceRefreshDelay: number("Polling interval (seconds)", { placeholder: "0", description: "0 disables polling." }),
		setterDelay: number("Setter delay (ms)", {
			placeholder: "0",
			description: "Wait before sending a set request; only the last value is sent.",
		}),
		bearerToken: secret("Bearer token", { description: TOKEN_HELP }),
		username: text("Username (Basic auth)"),
		password: secret("Password (Basic auth)"),
		immediately: bool("Send Basic credentials immediately", {
			description: "When off, credentials are sent only after the server answers 401.",
		}),
		timeout: number("Request timeout (ms)", { placeholder: "10000", description: "0 disables the timeout." }),
		retries: integer("Read retries", { placeholder: "0" }),
		cacheTTL: number("Cache lifetime (seconds)", { description: "Defaults to the polling interval." }),
		maxConcurrent: integer("Maximum concurrent requests", { placeholder: "0", description: "0 means unlimited." }),
		allowUnsafeEval: bool("Allow unsafe eval", {
			description:
				"Allows script mappers and JavaScript in ${...} templates, which run arbitrary code with the privileges of Homebridge.",
		}),
		statusFault: bool("Report failed reads as Status Fault", {
			description:
				"Sets the Status Fault characteristic of a service while one of its reads fails, so that the Home app shows the accessory as faulty. Only for services that have this characteristic.",
		}),
		debug: bool("Debug logging"),
	};
}

const MAPPER_TYPES = [
	["regex", "Regular expression"],
	["static", "Static mapping"],
	["xpath", "XPath"],
	["jpath", "JSONPath"],
	["number", "Number"],
	["scale", "Scale a number"],
	["expression", "Expression"],
	["script", "Script (needs allowUnsafeEval)"],
];

// Fields are shown only where they apply. The form evaluates `condition` with the whole config (`model`) and
// the indexes of the enclosing arrays, so each condition spells out where its field lives in the model.
// A characteristic of the device and one of an additional service live at different places, so each gets a scope.
// The form of a single device (the custom UI edits one at a time) has the device itself as its model.
const PLATFORM_SCOPES = {
	primary: {
		characteristic: "model.devices?.[arrayIndices[0]]?.characteristics?.[arrayIndices[1]]",
		mapperIndex: "arrayIndices[2]",
	},
	service: {
		characteristic:
			"model.devices?.[arrayIndices[0]]?.additionalServices?.[arrayIndices[1]]?.characteristics?.[arrayIndices[2]]",
		mapperIndex: "arrayIndices[3]",
	},
};
const DEVICE_SCOPES = {
	primary: {
		characteristic: "model?.characteristics?.[arrayIndices[0]]",
		mapperIndex: "arrayIndices[1]",
	},
	service: {
		characteristic: "model?.additionalServices?.[arrayIndices[0]]?.characteristics?.[arrayIndices[1]]",
		mapperIndex: "arrayIndices[2]",
	},
};
const inModel = (path) =>
	path
		.split(".")
		.map((key) => `?.${key}`)
		.join("");
const when = (functionBody) => ({ condition: { functionBody } });
const mapperTypeIs = (scope, path, types) =>
	when(
		`const m = ${scope.characteristic}${inModel(path)}?.mappers?.[${scope.mapperIndex}]; return ${JSON.stringify(types)}.includes(m?.type);`
	);

function mapper(scope, path) {
	const typeIs = (...types) => mapperTypeIs(scope, path, types);
	return object({
		type: choice("Type", MAPPER_TYPES),
		regexp: text("Regular expression", { description: "Type regex.", ...typeIs("regex") }),
		capture: text("Capture group", { placeholder: "1", description: "Type regex.", ...typeIs("regex") }),
		xpath: text("XPath", { description: "Type xpath.", ...typeIs("xpath") }),
		jpath: text("JSONPath", { description: "Type jpath.", ...typeIs("jpath") }),
		index: integer("Index", {
			placeholder: "0",
			description: "Which match to return.",
			...typeIs("xpath", "jpath"),
		}),
		mapping: {
			title: "Mapping",
			type: "array",
			description: "Type static.",
			items: { ...object({ from: text("From"), to: text("To") }), title: "Pair" },
			...typeIs("static"),
		},
		inputMin: signed("Input minimum", { description: "Type scale.", ...typeIs("scale") }),
		inputMax: signed("Input maximum", {
			description: "Type scale. Must differ from the minimum.",
			...typeIs("scale"),
		}),
		outputMin: signed("Output minimum", { description: "Type scale.", ...typeIs("scale") }),
		outputMax: signed("Output maximum", { description: "Type scale.", ...typeIs("scale") }),
		round: integer("Decimal places", {
			maximum: 10,
			placeholder: "no rounding",
			description: "Type number or scale.",
			...typeIs("number", "scale"),
		}),
		clamp: bool("Limit to the input range", {
			description: "Type scale. Without it, numbers outside the input range extrapolate.",
			...typeIs("scale"),
		}),
		expression: text("Expression", {
			widget: "textarea",
			description: "Type expression.",
			...typeIs("expression"),
		}),
		script: text("Script", { widget: "textarea", description: "Type script.", ...typeIs("script") }),
	});
}

// The form always adds a "None" entry to a select. Dropping it needs a null value in the schema, which crashes the
// form, and radio buttons render badly, so None stays and means the default.
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function httpMethod() {
	return {
		title: "HTTP method",
		type: ["string", "null"],
		enum: HTTP_METHODS,
		description: "None uses GET.",
	};
}

/**
 * @param {{characteristic: string, mapperIndex: string}} scope Where the characteristic lives in the form model
 * @param {string} path Where the action lives inside a characteristic: get, set or get.inconclusive
 */
function action(scope, path, withInconclusive) {
	const properties = {
		url: text("URL"),
		httpMethod: httpMethod(),
		body: text("Body", { widget: "textarea" }),
		resultOnError: text("Result on error", {
			description: "Used as the value when the request fails, instead of reporting an error.",
		}),
		bearerToken: secret("Bearer token", { description: "Overrides the device token for this action. " + TOKEN_HELP }),
		headers: headersList("Headers", "Sent with this request in addition to those of the device. "),
		mappers: { title: "Mappers", type: "array", items: { ...mapper(scope, path), title: "Mapper" } },
	};
	if (withInconclusive) {
		// The form cannot recurse, so one fallback level is described. It is shown only when the config has one:
		// a form cannot add it without showing a second copy of every action field.
		properties.inconclusive = {
			...action(scope, `${path}.inconclusive`, false),
			title: "Fallback action",
			...collapsed,
			description: "Used when a mapper returns inconclusive. Add it in the JSON config.",
			...when(`return Boolean(${scope.characteristic}${inModel(path)}?.inconclusive);`),
		};
	}
	return object(properties);
}

function props() {
	return object({
		format: choice(
			"Format",
			["bool", "int", "float", "string", "uint8", "uint16", "uint32", "uint64"].map((format) => [format, format])
		),
		unit: choice("Unit", [
			["celsius", "celsius"],
			["percentage", "percentage"],
			["arcdegrees", "arcdegrees"],
			["lux", "lux"],
			["seconds", "seconds"],
		]),
		minValue: { title: "Minimum value", type: "number" },
		maxValue: { title: "Maximum value", type: "number" },
		minStep: { title: "Minimum step", type: "number" },
		validValues: { title: "Valid values", type: "array", items: { title: "Value", type: "number" } },
		validValueRanges: { title: "Valid value ranges", type: "array", items: { title: "Bound", type: "number" } },
		perms: { title: "Permissions", type: "array", items: { title: "Permission", type: "string" } },
		maxLen: integer("Maximum length"),
	});
}

function characteristic(scope, names) {
	return object({
		characteristic: characteristicName(
			"Characteristic",
			{ description: "The characteristic to read or set, for example On or Brightness." },
			names
		),
		get: { ...action(scope, "get", true), title: "Get action" },
		set: { ...action(scope, "set", true), title: "Set action", ...collapsed },
		props: { ...props(), title: "Characteristic properties", ...collapsed },
	});
}

/** @param {{extraCharacteristic?: string[], extraOption?: string[]}} lists */
function additionalService(scopes, lists) {
	return object({
		id: text("Identifier", {
			description:
				"Permanent identifier of the service on this accessory. Changing it makes HomeKit see a different service.",
		}),
		name: text("Name", {
			description: "Name of the service in HomeKit. Defaults to the device name and the identifier.",
		}),
		service: serviceName("Service", { description: "HomeKit service type, for example HumiditySensor or Battery." }),
		characteristics: {
			title: "Characteristics",
			type: "array",
			items: { ...characteristic(scopes.service, lists.extraCharacteristic), title: "Characteristic" },
		},
		optionCharacteristic: optionCharacteristics(
			"Optional characteristics of the service to expose, for example BatteryLevel.",
			lists.extraOption
		),
	});
}

/** @param {{characteristic?: string[], option?: string[], extraCharacteristic?: string[], extraOption?: string[]}} [lists] */
function device(scopes, lists = {}) {
	return object({
		name: text("Name", { description: "Name shown in HomeKit." }),
		id: text("Identifier", {
			description: "Keeps the accessory in HomeKit when the device is renamed. Defaults to the name.",
		}),
		service: serviceName("Service", {
			description: "HomeKit service type, for example Switch, Lightbulb or TemperatureSensor.",
		}),
		characteristics: {
			title: "Characteristics",
			type: "array",
			items: { ...characteristic(scopes.primary, lists.characteristic), title: "Characteristic" },
		},
		optionCharacteristic: optionCharacteristics(
			"Optional characteristics of the service to expose, for example Brightness.",
			lists.option
		),
		additionalServices: {
			title: "Additional services",
			type: "array",
			description:
				"More services on the same accessory, for example humidity next to a temperature sensor, or a battery.",
			items: { ...additionalService(scopes, lists), title: "Service" },
		},
		...settings(),
	});
}

/**
 * The form of one device, for the custom UI to edit a device on its own. It describes the same settings as the
 * `devices` of the platform form; only the paths in the conditions differ, since the device is the whole model.
 *
 * @param {{characteristic?: string[], option?: string[], extraCharacteristic?: string[], extraOption?: string[]}} [lists]
 *   The names to offer for the characteristics and the optional characteristics, of the device and of its additional
 *   services. Without them every name is offered.
 */
function buildDeviceFormSchema(lists) {
	return { schema: { ...device(DEVICE_SCOPES, lists), title: "Device" }, layout: null, form: null };
}

/**
 * The settings that every device inherits, as a form of their own for the custom UI. It is the same list as the
 * `defaults` of the platform form, but open from the start.
 */
function buildDefaultsFormSchema() {
	return { schema: { ...object(settings()), title: "Defaults" }, layout: null, form: null };
}

/** The config.schema.json of the HttpAdvancedPlatform. */
function buildSchema() {
	return {
		pluginAlias: PLATFORM_NAME,
		pluginType: "platform",
		singular: true,
		// Opens homebridge-ui/, which keeps this form available underneath (see homebridge-ui/public/app.js)
		customUi: true,
		headerDisplay:
			"Turns devices that expose an HTTP API into HomeKit accessories. Settings under *Defaults* apply to every device unless the device sets its own.",
		schema: {
			type: "object",
			properties: {
				name: text("Name", { placeholder: "HTTP Advanced" }),
				defaults: { ...object(settings()), title: "Defaults", ...collapsed },
				devices: { title: "Devices", type: "array", items: { ...device(PLATFORM_SCOPES), title: "Device" } },
			},
		},
	};
}

module.exports = {
	buildSchema,
	buildDeviceFormSchema,
	buildDefaultsFormSchema,
	HTTP_METHODS,
	SERVICE_NAMES,
	OPTIONAL_CHARACTERISTICS,
};

const { PLATFORM_NAME } = require("./constants.js");

// The Homebridge UI form generator cannot render objects with user-defined keys and drops what the schema
// does not describe when the form is saved, so everything below is an object with fixed properties or an array.
// It must also avoid `required` and `default` inside array items: the form shows a blank first item.

const text = (title, extra = {}) => ({ title, type: "string", ...extra });
const number = (title, extra = {}) => ({ title, type: "number", minimum: 0, ...extra });
const integer = (title, extra = {}) => ({ title, type: "integer", minimum: 0, ...extra });
const bool = (title, extra = {}) => ({ title, type: "boolean", ...extra });
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

function settings() {
	return {
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
		debug: bool("Debug logging"),
	};
}

const MAPPER_TYPES = [
	["regex", "Regular expression"],
	["static", "Static mapping"],
	["xpath", "XPath"],
	["jpath", "JSONPath"],
	["expression", "Expression"],
	["script", "Script (needs allowUnsafeEval)"],
];

// Fields are shown only where they apply. The form evaluates `condition` with the whole config (`model`) and
// the indexes of the enclosing arrays, so each condition spells out where its field lives in the model.
const CHARACTERISTIC = "model.devices?.[arrayIndices[0]]?.characteristics?.[arrayIndices[1]]";
const inModel = (path) =>
	path
		.split(".")
		.map((key) => `?.${key}`)
		.join("");
const when = (functionBody) => ({ condition: { functionBody } });
const mapperTypeIs = (path, types) =>
	when(
		`const m = ${CHARACTERISTIC}${inModel(path)}?.mappers?.[arrayIndices[2]]; return ${JSON.stringify(types)}.includes(m?.type);`
	);

function mapper(path) {
	return object({
		type: choice("Type", MAPPER_TYPES),
		regexp: text("Regular expression", { description: "Type regex.", ...mapperTypeIs(path, ["regex"]) }),
		capture: text("Capture group", { placeholder: "1", description: "Type regex.", ...mapperTypeIs(path, ["regex"]) }),
		xpath: text("XPath", { description: "Type xpath.", ...mapperTypeIs(path, ["xpath"]) }),
		jpath: text("JSONPath", { description: "Type jpath.", ...mapperTypeIs(path, ["jpath"]) }),
		index: integer("Index", {
			placeholder: "0",
			description: "Which match to return.",
			...mapperTypeIs(path, ["xpath", "jpath"]),
		}),
		mapping: {
			title: "Mapping",
			type: "array",
			description: "Type static.",
			items: { ...object({ from: text("From"), to: text("To") }), title: "Pair" },
			...mapperTypeIs(path, ["static"]),
		},
		expression: text("Expression", {
			widget: "textarea",
			description: "Type expression.",
			...mapperTypeIs(path, ["expression"]),
		}),
		script: text("Script", { widget: "textarea", description: "Type script.", ...mapperTypeIs(path, ["script"]) }),
	});
}

// The form adds a "None" entry to a select unless one of its values is null, so the default is a null entry named GET.
function httpMethod() {
	const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
	return {
		title: "HTTP method",
		type: ["string", "null"],
		enum: [null, ...methods],
		"x-schema-form": {
			type: "select",
			titleMap: [{ name: "GET (default)", value: null }, ...methods.slice(1).map((name) => ({ name, value: name }))],
		},
	};
}

/** @param {string} path Where the action lives inside a characteristic: get, set or get.inconclusive */
function action(path, withInconclusive) {
	const properties = {
		url: text("URL"),
		httpMethod: httpMethod(),
		body: text("Body", { widget: "textarea" }),
		resultOnError: text("Result on error", {
			description: "Used as the value when the request fails, instead of reporting an error.",
		}),
		bearerToken: secret("Bearer token", { description: "Overrides the device token for this action. " + TOKEN_HELP }),
		mappers: { title: "Mappers", type: "array", items: { ...mapper(path), title: "Mapper" } },
	};
	if (withInconclusive) {
		// The form cannot recurse, so one fallback level is described. It is shown only when the config has one:
		// a form cannot add it without showing a second copy of every action field.
		properties.inconclusive = {
			...action(`${path}.inconclusive`, false),
			title: "Fallback action",
			...collapsed,
			description: "Used when a mapper returns inconclusive. Add it in the JSON config.",
			...when(`return Boolean(${CHARACTERISTIC}${inModel(path)}?.inconclusive);`),
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

function characteristic() {
	return object({
		characteristic: text("Characteristic", {
			placeholder: "On",
			description: "Characteristic name, for example On or Brightness.",
		}),
		get: { ...action("get", true), title: "Get action" },
		set: { ...action("set", true), title: "Set action", ...collapsed },
		props: { ...props(), title: "Characteristic properties", ...collapsed },
	});
}

function device() {
	return object({
		name: text("Name", { description: "Name shown in HomeKit." }),
		id: text("Identifier", {
			description: "Keeps the accessory in HomeKit when the device is renamed. Defaults to the name.",
		}),
		service: text("Service", {
			placeholder: "Switch",
			description: "HomeKit service type, for example Switch, Lightbulb or TemperatureSensor.",
		}),
		characteristics: {
			title: "Characteristics",
			type: "array",
			items: { ...characteristic(), title: "Characteristic" },
		},
		optionCharacteristic: {
			title: "Optional characteristics",
			type: "array",
			description: "Optional characteristics of the service to expose, for example Brightness.",
			items: { title: "Characteristic", type: "string" },
		},
		...settings(),
	});
}

/** The config.schema.json of the HttpAdvancedPlatform. */
function buildSchema() {
	return {
		pluginAlias: PLATFORM_NAME,
		pluginType: "platform",
		singular: true,
		headerDisplay:
			"Turns devices that expose an HTTP API into HomeKit accessories. Settings under *Defaults* apply to every device unless the device sets its own.",
		schema: {
			type: "object",
			properties: {
				name: text("Name", { placeholder: "HTTP Advanced" }),
				defaults: { ...object(settings()), title: "Defaults", ...collapsed },
				devices: { title: "Devices", type: "array", items: { ...device(), title: "Device" } },
			},
		},
	};
}

module.exports = { buildSchema };

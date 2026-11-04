const Ajv = require("ajv");
const { buildSchema, HTTP_METHODS } = require("./schema.js");

// The validation uses a copy of the form schema that differs in two places. The form schema cannot contain null (see
// schema.js), so the copy accepts it for an unset method; and the fixed lists of the form are left out.
function forValidation(node) {
	if (!node || typeof node !== "object") return node;
	if (node.properties && node.properties.httpMethod) node.properties.httpMethod.enum = [null, ...HTTP_METHODS];
	// The lists of names are for the form; a name that is not in them is checked when the device loads
	if (node.properties && node.properties.characteristic) delete node.properties.characteristic.enum;
	if (node.properties && node.properties.optionCharacteristic) delete node.properties.optionCharacteristic.items.enum;
	if (node.properties && node.properties.service) delete node.properties.service.enum;
	for (const value of Object.values(node)) forValidation(value);
	return node;
}

const platformSchema = forValidation(structuredClone(buildSchema().schema));

// strict is off because the schema carries form keywords (title, widget, placeholder) that Ajv does not know;
// coerceTypes accepts what the UI and hand-edited JSON produce, such as "0" for a number.
const ajv = new Ajv({ allErrors: true, coerceTypes: true, strict: false, verbose: true });

const checkDevice = ajv.compile(platformSchema.properties.devices.items);
// The settings that Homebridge adds to the block of a platform itself, for example the child bridge settings (_bridge)
const checkRoot = ajv.compile({
	type: "object",
	properties: {
		platform: { type: "string" },
		name: platformSchema.properties.name,
		_bridge: { type: "object" },
		defaults: platformSchema.properties.defaults,
		devices: { type: "array" },
	},
	additionalProperties: false,
});

function describe(error) {
	const where = error.instancePath
		.slice(1)
		.replace(/\/(\d+)/g, "[$1]")
		.replace(/\//g, ".");
	const prefix = where ? where + " " : "";

	if (error.keyword === "additionalProperties") {
		return `${prefix}has an unknown setting "${error.params.additionalProperty}"`;
	}
	if (error.keyword === "oneOf" && Array.isArray(error.schema)) {
		const values = error.schema.map((option) => option.enum && option.enum[0]).filter(Boolean);
		return `${prefix}must be one of: ${values.join(", ")}`;
	}
	if (error.keyword === "enum") {
		return `${prefix}must be one of: ${error.params.allowedValues.filter((value) => value !== null).join(", ")}`;
	}
	return `${prefix}${error.message}`;
}

function messages(errors) {
	// The failing branches of a oneOf only repeat the oneOf error
	return (errors || []).filter((error) => !error.schemaPath.includes("/oneOf/")).map(describe);
}

/**
 * Validates the platform settings outside `devices`.
 * @returns {string[]} problems, empty when valid
 */
function validatePlatform(config) {
	checkRoot(structuredClone(config));
	return messages(checkRoot.errors);
}

/**
 * Validates one device. Values are coerced on a copy ("5" becomes 5); the input is left untouched.
 * @returns {{device: Object, errors: string[]}}
 */
function validateDevice(device) {
	const copy = structuredClone(device);
	checkDevice(copy);
	return { device: copy, errors: messages(checkDevice.errors) };
}

module.exports = { validatePlatform, validateDevice };

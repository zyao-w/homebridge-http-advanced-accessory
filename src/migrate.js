const { PLUGIN_NAME, ACCESSORY_NAME, PLATFORM_NAME } = require("./constants.js");

// Settings copied as they are from an accessory to a device
const DEVICE_KEYS = [
	"name",
	"service",
	"optionCharacteristic",
	"forceRefreshDelay",
	"setterDelay",
	"debug",
	"username",
	"password",
	"bearerToken",
	"immediately",
	"timeout",
	"retries",
	"cacheTTL",
	"maxConcurrent",
	"allowUnsafeEval",
];
const IGNORED_KEYS = ["accessory", "urls", "props", "uriCallsDelay"];
const ACTION_KEYS = ["url", "httpMethod", "body", "resultOnError"];
const PROP_KEYS = [
	"format",
	"unit",
	"minValue",
	"maxValue",
	"minStep",
	"validValues",
	"validValueRanges",
	"perms",
	"maxLen",
];

// JavaScript that the restricted expression language of 2.0.0 does not offer
const JS_ONLY =
	/\b(Math|parseInt|parseFloat|Number|String|JSON|Date|Object|Array|new|function)\b|\.\s*[A-Za-z_]\w*\s*\(/;
// Statements, optional chaining and assignments make an eval mapper a script
const SCRIPT_ONLY = /\b(let|const|var|if|else|for|while|return|try|catch|throw|switch)\b|[;{}]|\?\.|(^|[^=!<>])=(?!=)/;
const STATE_KEY = /\b(?:self\.)?state(?:\.get(\w+)|\[\s*(["'])get(\w+)\2\s*\])/g;

/** state used to be keyed by action name (getOn), it is now keyed by characteristic name (On). */
function migrateStateReferences(text) {
	return text.replace(STATE_KEY, (match, dotted, quote, bracketed) =>
		dotted ? `state.${dotted}` : `state["${bracketed}"]`
	);
}

function warnAboutJavaScript(expression, where, warnings) {
	if (JS_ONLY.test(expression)) {
		warnings.push(
			`${where}: "${expression}" uses JavaScript that the restricted expression language does not offer; it needs "allowUnsafeEval": true`
		);
	}
}

function migrateTemplate(template, where, warnings) {
	if (typeof template !== "string") {
		return template;
	}
	const migrated = migrateStateReferences(template);
	for (const [, expression] of migrated.matchAll(/\$\{([^}]*)\}/g)) {
		warnAboutJavaScript(expression, where, warnings);
	}
	return migrated;
}

function migrateMapper(mapper, where, warnings) {
	const { type, parameters = {} } = mapper;

	if (type === "static") {
		const mapping = parameters.mapping || {};
		return { type, mapping: Object.keys(mapping).map((from) => ({ from, to: mapping[from] })) };
	}
	if (type === "eval") {
		const expression = migrateStateReferences(String(parameters.expression === undefined ? "" : parameters.expression));
		if (SCRIPT_ONLY.test(expression) || JS_ONLY.test(expression)) {
			warnings.push(
				`${where}: uses JavaScript statements or functions, so it became a "script" mapper; set "allowUnsafeEval": true to keep it working`
			);
			return { type: "script", script: expression };
		}
		return { type: "expression", expression };
	}
	if (["regex", "xpath", "jpath"].includes(type)) {
		return { type, ...parameters };
	}

	warnings.push(`${where}: unknown mapper type "${type}" was dropped`);
	return undefined;
}

function migrateAction(description, where, warnings) {
	const action = {};

	for (const key of ACTION_KEYS) {
		if (description[key] !== undefined) {
			action[key] = description[key];
		}
	}
	action.url = migrateTemplate(description.url, `${where} url`, warnings);
	if (action.body) {
		action.body = migrateTemplate(action.body, `${where} body`, warnings);
	}

	if (Array.isArray(description.mappers)) {
		action.mappers = description.mappers
			.map((mapper, index) => migrateMapper(mapper, `${where} mapper ${index + 1}`, warnings))
			.filter(Boolean);
	}
	if (description.inconclusive) {
		action.inconclusive = migrateAction(description.inconclusive, `${where} inconclusive`, warnings);
	}

	return action;
}

/**
 * Converts one accessory configuration into a platform device.
 * @returns {{device: Object, warnings: string[]}}
 */
function migrateAccessory(accessory) {
	const warnings = [];
	const device = {};
	const name = accessory.name;

	for (const key of DEVICE_KEYS) {
		if (accessory[key] !== undefined) {
			device[key] = accessory[key];
		}
	}

	if (accessory.uriCallsDelay > 0) {
		if (device.maxConcurrent === undefined) {
			device.maxConcurrent = 1;
		}
		warnings.push(`${name}: "uriCallsDelay" was removed; "maxConcurrent": 1 now serializes the requests`);
	}

	for (const key of Object.keys(accessory)) {
		if (!DEVICE_KEYS.includes(key) && !IGNORED_KEYS.includes(key)) {
			warnings.push(`${name}: "${key}" is not supported and was dropped`);
		}
	}

	const characteristics = new Map();
	const entryFor = (characteristic) => {
		if (!characteristics.has(characteristic)) {
			characteristics.set(characteristic, { characteristic });
		}
		return characteristics.get(characteristic);
	};

	for (const key of Object.keys(accessory.urls || {})) {
		const match = /^(get|set)(.+)$/.exec(key);
		if (!match) {
			warnings.push(`${name}: action "${key}" is neither a getXxx nor a setXxx action and was dropped`);
			continue;
		}
		entryFor(match[2])[match[1]] = migrateAction(accessory.urls[key], `${name} ${key}`, warnings);
	}

	for (const characteristic of Object.keys(accessory.props || {})) {
		const props = {};
		for (const key of Object.keys(accessory.props[characteristic])) {
			if (PROP_KEYS.includes(key)) {
				props[key] = accessory.props[characteristic][key];
			} else {
				warnings.push(`${name}: property "${key}" of ${characteristic} is not supported and was dropped`);
			}
		}
		entryFor(characteristic).props = props;
	}

	device.characteristics = [...characteristics.values()];
	return { device, warnings };
}

const isHttpAdvancedAccessory = (accessory) =>
	accessory && (accessory.accessory === ACCESSORY_NAME || accessory.accessory === `${PLUGIN_NAME}.${ACCESSORY_NAME}`);

/**
 * Moves every HttpAdvancedAccessory of a Homebridge config.json into one platform block.
 * Other accessories and platforms are left untouched.
 * @returns {{config: Object, warnings: string[], migrated: number}}
 */
function migrateConfig(config) {
	const warnings = [];
	const devices = [];
	const remaining = [];

	for (const accessory of config.accessories || []) {
		if (isHttpAdvancedAccessory(accessory)) {
			const result = migrateAccessory(accessory);
			devices.push(result.device);
			warnings.push(...result.warnings);
		} else {
			remaining.push(accessory);
		}
	}

	const migrated = { ...config };
	if (devices.length > 0) {
		migrated.accessories = remaining;
		migrated.platforms = [...(config.platforms || []), { platform: PLATFORM_NAME, name: "HTTP Advanced", devices }];
	}

	return { config: migrated, warnings, migrated: devices.length };
}

module.exports = { migrateAccessory, migrateConfig };

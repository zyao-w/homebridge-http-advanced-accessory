const { resolveBearerToken } = require("./http/auth.js");
const { createMapper } = require("./mappers/index.js");
const { compileTemplate } = require("./expression.js");

const SETTING_KEYS = [
	"manufacturer",
	"model",
	"serialNumber",
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

const DEFAULT_INFORMATION = {
	manufacturer: "Custom Manufacturer",
	model: "HTTP Accessory Model",
	serialNumber: "HTTP Accessory Serial Number",
};

// HomeKit rejects an empty value, so anything but text or a number falls back to the default
function informationValue(value, fallback) {
	const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
	return typeof text === "string" && text.trim() ? text.trim() : fallback;
}

function resolveToken(value) {
	try {
		return { bearerToken: resolveBearerToken(value) };
	} catch (error) {
		return { bearerToken: "", error };
	}
}

// Mappers are written flat ({ type, regexp }); the mapper classes take their parameters separately
function createMapperFromEntry(entry, context, where) {
	const { type, ...parameters } = entry;

	if (type === "static") {
		const pairs = Array.isArray(parameters.mapping) ? parameters.mapping : [];
		parameters.mapping = Object.fromEntries(pairs.map(({ from, to }) => [from, to]));
	} else if (type === "script" && !context.allowUnsafeEval) {
		throw new Error(`${where}: a "script" mapper runs arbitrary JavaScript and needs "allowUnsafeEval": true`);
	}

	let mapper;
	try {
		mapper = createMapper(type, parameters, context);
	} catch (error) {
		throw new Error(`${where}: ${error.message}`);
	}
	if (!mapper && context.warn) {
		context.warn(`${where}: unknown mapper type "${entry.type}" ignored`);
	}
	return mapper;
}

function createAction(definition, context, where) {
	if (!definition.url) {
		throw new Error(`${where} has no url`);
	}

	const action = {
		url: definition.url,
		httpMethod: definition.httpMethod || "GET",
		body: definition.body || "",
		resultOnError: definition.resultOnError,
	};

	if (definition.mappers) {
		action.mappers = definition.mappers.map((entry) => createMapperFromEntry(entry, context, where)).filter(Boolean);
	}
	if (definition.bearerToken !== undefined) {
		// Overrides the device and platform token for this action only
		action.auth = resolveToken(definition.bearerToken);
	}
	if (definition.inconclusive) {
		action.inconclusive = createAction(definition.inconclusive, context, `${where} inconclusive`);
	}

	return action;
}

// Set templates are compiled when the device loads, so a mistake shows at startup and not on the first set
function checkTemplates(action, context, where) {
	try {
		for (const template of [action.url, action.body]) {
			if (template) compileTemplate(template, { unsafe: context.allowUnsafeEval });
		}
	} catch (error) {
		throw new Error(`${where}: ${error.message}. Full JavaScript needs "allowUnsafeEval": true`);
	}
}

function createCharacteristic(entry, context, deviceName) {
	if (!entry || typeof entry.characteristic !== "string" || !entry.characteristic) {
		throw new Error(`Device "${deviceName}": a characteristic entry has no "characteristic" name`);
	}

	const name = entry.characteristic;
	const where = `Device "${deviceName}" ${name}`;
	const characteristic = { name, props: entry.props || {} };

	if (entry.get) characteristic.get = createAction(entry.get, context, `${where} get`);
	if (entry.set) {
		characteristic.set = createAction(entry.set, context, `${where} set`);
		checkTemplates(characteristic.set, context, `${where} set`);
	}

	return characteristic;
}

/**
 * Validates a platform device and merges the platform `defaults` under its own settings.
 *
 * An unreadable bearerToken does not throw: it is reported in `authError` so the device can log it
 * and fail its requests instead of falling back to Basic authentication.
 *
 * @param {Object} device One entry of the platform `devices`
 * @param {Object} [defaults] The platform `defaults`
 * @param {{warn?: Function}} [options]
 */
function normalizeDevice(device, defaults = {}, options = {}) {
	if (!device || typeof device.name !== "string" || !device.name) {
		throw new Error('A device has no "name"');
	}
	if (typeof device.service !== "string" || !device.service) {
		throw new Error(`Device "${device.name}" has no "service"`);
	}

	const settings = {};
	for (const key of SETTING_KEYS) {
		const value = device[key] !== undefined ? device[key] : defaults[key];
		if (value !== undefined) {
			settings[key] = value;
		}
	}

	const forceRefreshDelay = settings.forceRefreshDelay || 0;
	const token = resolveToken(settings.bearerToken);
	const state = {};
	const context = { state, warn: options.warn, allowUnsafeEval: settings.allowUnsafeEval === true };

	const characteristics = (device.characteristics || []).map((entry) =>
		createCharacteristic(entry, context, device.name)
	);
	const seen = new Set();
	for (const { name } of characteristics) {
		if (seen.has(name)) {
			throw new Error(`Device "${device.name}": characteristic "${name}" is listed twice`);
		}
		seen.add(name);
	}

	return {
		id: typeof device.id === "string" && device.id ? device.id : device.name,
		name: device.name,
		service: device.service,
		optionCharacteristic: device.optionCharacteristic || [],
		information: {
			manufacturer: informationValue(settings.manufacturer, DEFAULT_INFORMATION.manufacturer),
			model: informationValue(settings.model, DEFAULT_INFORMATION.model),
			serialNumber: informationValue(settings.serialNumber, DEFAULT_INFORMATION.serialNumber),
		},
		forceRefreshDelay,
		setterDelay: settings.setterDelay || 0,
		debug: settings.debug,
		auth: {
			username: settings.username || "",
			password: settings.password || "",
			bearerToken: token.bearerToken,
			immediately: settings.immediately !== undefined ? settings.immediately : true,
		},
		allowUnsafeEval: context.allowUnsafeEval,
		authError: token.error || null,
		http: {
			timeout: settings.timeout,
			retries: settings.retries,
			cacheTTL: settings.cacheTTL !== undefined ? settings.cacheTTL : forceRefreshDelay,
			maxConcurrent: settings.maxConcurrent,
		},
		state,
		characteristics,
	};
}

module.exports = { normalizeDevice };

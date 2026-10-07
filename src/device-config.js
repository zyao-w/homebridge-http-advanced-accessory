const { resolveBearerToken } = require("./http/auth.js");
const { createMapper } = require("./mappers/index.js");

const SETTING_KEYS = [
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

function resolveToken(value) {
	try {
		return { bearerToken: resolveBearerToken(value) };
	} catch (error) {
		return { bearerToken: "", error };
	}
}

// Mappers are written flat ({ type, regexp }); the mapper classes take their parameters separately
function createMapperFromEntry(entry, context, where) {
	let { type, ...parameters } = entry;

	if (type === "static") {
		const pairs = Array.isArray(parameters.mapping) ? parameters.mapping : [];
		parameters.mapping = Object.fromEntries(pairs.map(({ from, to }) => [from, to]));
	} else if (type === "script") {
		if (!context.allowUnsafeEval) {
			throw new Error(`${where}: a "script" mapper runs arbitrary JavaScript and needs "allowUnsafeEval": true`);
		}
		type = "eval";
		parameters = { expression: parameters.script };
	} else if (type === "expression") {
		// Transitional: evaluated like a script until the restricted expression engine replaces the eval mapper
		type = "eval";
	} else if (type === "eval") {
		// The 1.x name; 2.0 configs use "expression" or "script"
		type = undefined;
	}

	const mapper = type === undefined ? undefined : createMapper(type, parameters, context);
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

function createCharacteristic(entry, context, deviceName) {
	if (!entry || typeof entry.characteristic !== "string" || !entry.characteristic) {
		throw new Error(`Device "${deviceName}": a characteristic entry has no "characteristic" name`);
	}

	const name = entry.characteristic;
	const where = `Device "${deviceName}" ${name}`;
	const characteristic = { name, props: entry.props || {} };

	if (entry.get) characteristic.get = createAction(entry.get, context, `${where} get`);
	if (entry.set) characteristic.set = createAction(entry.set, context, `${where} set`);

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
		name: device.name,
		service: device.service,
		optionCharacteristic: device.optionCharacteristic || [],
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

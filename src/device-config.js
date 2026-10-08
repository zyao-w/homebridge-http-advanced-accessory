const { resolveBearerToken } = require("./http/auth.js");
const { mergeHeaders, resolveHeaders } = require("./http/headers.js");
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
	if (Array.isArray(definition.headers) && mergeHeaders(definition.headers).length > 0) {
		// Sent in addition to the headers of the device; the same name replaces them
		const resolved = resolveHeaders(definition.headers, where);
		action.headers = resolved.headers;
		if (resolved.error) action.headersError = resolved.error;
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

function createCharacteristic(entry, context, label) {
	if (!entry || typeof entry.characteristic !== "string" || !entry.characteristic) {
		throw new Error(`${label}: a characteristic entry has no "characteristic" name`);
	}

	const name = entry.characteristic;
	const where = `${label} ${name}`;
	const characteristic = { name, props: entry.props || {} };

	if (entry.get) characteristic.get = createAction(entry.get, context, `${where} get`);
	if (entry.set) {
		characteristic.set = createAction(entry.set, context, `${where} set`);
		checkTemplates(characteristic.set, context, `${where} set`);
	}

	return characteristic;
}

/** @param {string} label Names the device or service in messages, for example `Device "Lamp"` */
function createCharacteristics(entries, context, label) {
	const characteristics = (entries || []).map((entry) => createCharacteristic(entry, context, label));
	const seen = new Set();
	for (const { name } of characteristics) {
		if (seen.has(name)) {
			throw new Error(`${label}: characteristic "${name}" is listed twice`);
		}
		seen.add(name);
	}
	return characteristics;
}

/**
 * Each additional service keeps its values in `state[id]`, next to the characteristics of the device in `state`.
 * An id that equals the name of a characteristic of the device would clash with it.
 */
function createAdditionalServices(entries, device, state, context) {
	const primaryNames = new Set((device.characteristics || []).map((entry) => entry && entry.characteristic));
	const services = [];
	const ids = new Set();

	(entries || []).forEach((entry, index) => {
		// The form shows an empty row for a list that has no entries; it is not a service
		if (entry && typeof entry === "object" && Object.keys(entry).length === 0) {
			return;
		}

		const where = `Device "${device.name}" additional service ${index + 1}`;
		if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
			throw new Error(`${where} has no "id"`);
		}
		const id = entry.id;
		const label = `Device "${device.name}" service "${id}"`;
		if (typeof entry.service !== "string" || !entry.service) {
			throw new Error(`${label} has no "service"`);
		}
		if (ids.has(id)) {
			throw new Error(`Device "${device.name}": the service id "${id}" is used twice`);
		}
		if (id === "__proto__" || primaryNames.has(id)) {
			throw new Error(`${label}: the id clashes with a characteristic of the device, choose another one`);
		}
		ids.add(id);

		state[id] = {};
		services.push({
			id,
			name: typeof entry.name === "string" && entry.name ? entry.name : `${device.name} ${id}`,
			service: entry.service,
			optionCharacteristic: entry.optionCharacteristic || [],
			characteristics: createCharacteristics(entry.characteristics, context, label),
			state: state[id],
		});
	});

	return services;
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
	// The headers of the platform defaults come first, so that a device can replace them by name
	const headers = resolveHeaders(mergeHeaders(defaults.headers, device.headers), `Device "${device.name}"`);
	const state = {};
	const context = { state, warn: options.warn, allowUnsafeEval: settings.allowUnsafeEval === true };

	const characteristics = createCharacteristics(device.characteristics, context, `Device "${device.name}"`);
	const additionalServices = createAdditionalServices(device.additionalServices, device, state, context);

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
		authError: token.error || headers.error || null,
		http: {
			timeout: settings.timeout,
			retries: settings.retries,
			cacheTTL: settings.cacheTTL !== undefined ? settings.cacheTTL : forceRefreshDelay,
			maxConcurrent: settings.maxConcurrent,
			headers: headers.headers,
		},
		state,
		characteristics,
		additionalServices,
	};
}

module.exports = { normalizeDevice };

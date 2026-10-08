const { resolveBearerToken } = require("./http/auth.js");

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

/**
 * Turns the raw accessory configuration into normalized options.
 *
 * A bearerToken that cannot be resolved does not throw: it is reported in `authError`
 * so the accessory can log it and fail its requests instead of crashing Homebridge.
 */
function parseConfig(config) {
	const forceRefreshDelay = config.forceRefreshDelay || 0;

	const auth = {
		username: config.username || "",
		password: config.password || "",
		bearerToken: "",
		immediately: "immediately" in config ? config.immediately : true,
	};
	let authError = null;
	try {
		auth.bearerToken = resolveBearerToken(config.bearerToken);
	} catch (error) {
		authError = error;
	}

	return {
		name: config.name,
		service: config.service,
		optionCharacteristic: config.optionCharacteristic || [],
		information: {
			manufacturer: informationValue(config.manufacturer, DEFAULT_INFORMATION.manufacturer),
			model: informationValue(config.model, DEFAULT_INFORMATION.model),
			serialNumber: informationValue(config.serialNumber, DEFAULT_INFORMATION.serialNumber),
		},
		props: config.props || {},
		forceRefreshDelay,
		setterDelay: config.setterDelay || 0,
		debug: config.debug,
		auth,
		authError,
		http: {
			timeout: config.timeout,
			retries: config.retries,
			cacheTTL: config.cacheTTL !== undefined ? config.cacheTTL : forceRefreshDelay,
			maxConcurrent: config.maxConcurrent,
			uriCallsDelay: config.uriCallsDelay,
		},
		urls: config.urls || {},
	};
}

module.exports = { parseConfig };

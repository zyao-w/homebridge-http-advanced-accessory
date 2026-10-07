const { resolveBearerToken } = require("./http/auth.js");

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

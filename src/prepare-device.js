const { normalizeDevice } = require("./device-config.js");
const { validateDevice } = require("./validate.js");

/**
 * Turns one entry of `devices` into a device that can run: merges the platform `defaults`, validates the settings
 * and normalizes them. The platform and the custom UI both use it, so the UI reports what the platform will do.
 *
 * @param {Object} raw One entry of the platform `devices`
 * @param {Object} [defaults] The platform `defaults`
 * @param {{warn?: Function}} [options]
 * @returns {{device: Object|null, validationErrors: string[], error: Error|null}}
 *   `validationErrors` are mistakes in the settings, `error` is a mistake found while the device was built
 */
function prepareDevice(raw, defaults = {}, options = {}) {
	const merged = { ...defaults, ...raw };
	// A device adds to the headers of the defaults instead of replacing them; a wrong type is left for the validation
	if (Array.isArray(defaults.headers) && Array.isArray(raw.headers)) {
		merged.headers = [...defaults.headers, ...raw.headers];
	}

	const { device: coerced, errors } = validateDevice(merged);
	if (errors.length) {
		return { device: null, validationErrors: errors, error: null };
	}

	try {
		return { device: normalizeDevice(coerced, {}, { warn: options.warn }), validationErrors: [], error: null };
	} catch (error) {
		return { device: null, validationErrors: [], error };
	}
}

module.exports = { prepareDevice };

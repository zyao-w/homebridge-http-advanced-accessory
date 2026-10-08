const { resolveSecret } = require("./auth.js");

// An HTTP header name is a token (RFC 9110); anything else could not be sent
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The empty row that the form shows for a list without entries is not a header. */
const isBlank = (entry) =>
	entry &&
	typeof entry === "object" &&
	!Array.isArray(entry) &&
	!entry.name &&
	(entry.value === undefined || entry.value === "");

/**
 * Puts header lists after each other; a header that is named again later (compared without regard to case) replaces
 * the earlier one, so a device can override a platform default and an action can override both.
 * @param {...Array<{name: string, value?: string}>} lists
 * @returns {Array<{name: string, value?: string}>}
 */
function mergeHeaders(...lists) {
	const merged = new Map();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (isBlank(entry)) continue;
			const key = entry && typeof entry.name === "string" ? entry.name.toLowerCase() : Symbol();
			merged.delete(key);
			merged.set(key, entry);
		}
	}
	return [...merged.values()];
}

/**
 * Turns a list of `{ name, value }` into the headers to send. A value is a literal text, `env:NAME` or `file:/path`.
 *
 * A wrong name or a value that is not text throws, as it is a mistake in the configuration. A value whose source cannot
 * be read does not throw: it is reported in `error` so that requests fail instead of going out without the header.
 *
 * @param {Array<{name: string, value?: string}>} list
 * @param {string} where Names the place in messages, for example `Device "Lamp"`
 * @returns {{headers: Object<string, string>, error: Error|null}}
 */
function resolveHeaders(list, where) {
	const headers = {};
	let error = null;

	for (const entry of mergeHeaders(list)) {
		if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !NAME.test(entry.name)) {
			throw new Error(`${where}: a header needs a name made of letters, digits and - _ . ! # $ % & ' * + ^ \` | ~`);
		}
		if (entry.value !== undefined && typeof entry.value !== "string" && typeof entry.value !== "number") {
			throw new Error(`${where}: the value of the header "${entry.name}" must be text`);
		}
		let value;
		try {
			value = resolveSecret(
				typeof entry.value === "number" ? String(entry.value) : entry.value,
				`header "${entry.name}"`
			);
		} catch (problem) {
			error = error || problem;
			continue;
		}
		if (/[\r\n]/.test(value)) {
			throw new Error(`${where}: the value of the header "${entry.name}" contains a line break`);
		}
		headers[entry.name] = value;
	}

	return { headers, error };
}

module.exports = { mergeHeaders, resolveHeaders, HEADER_NAME: NAME };

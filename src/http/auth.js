var fs = require("fs");

/**
 * Resolves a secret setting: a literal value, "env:NAME" (environment variable) or "file:/path" (file content).
 * The result is trimmed. Throws an Error (never containing the secret) when the source is unavailable.
 *
 * @param {*} value The raw config value
 * @param {string} label Names the setting in error messages
 * @returns {string} The value, or "" when it is not a string
 */
function resolveSecret(value, label) {
	if (typeof value !== "string") {
		return "";
	}

	var raw = value.trim();

	if (raw.indexOf("env:") === 0) {
		var name = raw.slice(4).trim();
		var fromEnv = (process.env[name] || "").trim();
		if (!fromEnv) {
			throw new Error(label + ': environment variable "' + name + '" is not set or empty');
		}
		return fromEnv;
	}

	if (raw.indexOf("file:") === 0) {
		var path = raw.slice(5).trim();
		var fromFile;
		try {
			fromFile = fs.readFileSync(path, "utf8").trim();
		} catch (e) {
			throw new Error(label + ': cannot read file "' + path + '" (' + e.code + ")");
		}
		if (!fromFile) {
			throw new Error(label + ': file "' + path + '" is empty');
		}
		return fromFile;
	}

	return raw;
}

/**
 * Resolves the configured bearer token (a literal token, "env:NAME" or "file:/path", trimmed).
 *
 * @param {*} value The raw `bearerToken` config value
 * @returns {string} The token, or "" when not configured
 */
function resolveBearerToken(value) {
	return resolveSecret(value, "bearerToken");
}

/**
 * Builds the Authorization header value.
 * Bearer takes precedence over Basic; returns undefined when no credentials are configured.
 */
function buildAuthorization({ username = "", password = "", bearerToken = "" } = {}) {
	if (bearerToken) {
		return "Bearer " + bearerToken;
	}
	if (username || password) {
		return "Basic " + Buffer.from(username + ":" + password).toString("base64");
	}
	return undefined;
}

module.exports = { resolveBearerToken, resolveSecret, buildAuthorization };

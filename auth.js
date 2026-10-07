var fs = require("fs");

/**
 * Resolves the configured bearer token.
 *
 * Supported forms: a literal token, "env:NAME" (environment variable) and
 * "file:/path" (file content). The result is trimmed.
 * Throws an Error (never containing the token) when the source is unavailable.
 *
 * @param {*} value The raw `bearerToken` config value
 * @returns {string} The token, or "" when not configured
 */
function resolveBearerToken(value) {
	if (typeof value !== "string") {
		return "";
	}

	var raw = value.trim();

	if (raw.indexOf("env:") === 0) {
		var name = raw.slice(4).trim();
		var fromEnv = (process.env[name] || "").trim();
		if (!fromEnv) {
			throw new Error("bearerToken: environment variable \"" + name + "\" is not set or empty");
		}
		return fromEnv;
	}

	if (raw.indexOf("file:") === 0) {
		var path = raw.slice(5).trim();
		var fromFile;
		try {
			fromFile = fs.readFileSync(path, "utf8").trim();
		} catch (e) {
			throw new Error("bearerToken: cannot read file \"" + path + "\" (" + e.code + ")");
		}
		if (!fromFile) {
			throw new Error("bearerToken: file \"" + path + "\" is empty");
		}
		return fromFile;
	}

	return raw;
}

module.exports = { resolveBearerToken };

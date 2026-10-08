const { STATUS_CODES } = require("node:http");
const { buildAuthorization } = require("./auth.js");
const Limiter = require("./limiter.js");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP client built on the global fetch (Node >= 18).
 *
 * - read():  idempotent requests; identical in-flight reads are shared and
 *            successful responses are cached for `cacheTTL` seconds.
 * - write(): never shared or cached, never retried; clears the cache on success.
 *
 * A response outside 2xx rejects with an error that has `status`; it is never retried or cached.
 */
class HttpClient {
	/**
	 * @param {Object} options
	 * @param {Object} [options.auth] { username, password, bearerToken, immediately }
	 * @param {number} [options.timeout=10000] Per-attempt timeout in ms (0 disables)
	 * @param {number} [options.retries=0] Extra attempts for reads after a network error or timeout
	 * @param {number} [options.retryDelay=500] Base delay in ms, multiplied by the attempt number
	 * @param {number} [options.cacheTTL=0] Cache lifetime in seconds (0 disables)
	 * @param {number} [options.maxConcurrent=0] Maximum simultaneous requests (0 = unlimited)
	 * @param {Function} [options.fetch] fetch implementation (for tests)
	 * @param {Function} [options.now] Clock in ms (for tests)
	 */
	constructor(options = {}) {
		this.fetch = options.fetch || globalThis.fetch;
		this.auth = options.auth || {};
		this.headers = options.headers || {};
		this.timeout = options.timeout === undefined ? 10000 : options.timeout;
		this.retries = options.retries || 0;
		this.retryDelay = options.retryDelay === undefined ? 500 : options.retryDelay;
		this.cacheTTL = (options.cacheTTL || 0) * 1000;
		this.now = options.now || Date.now;
		this.limiter = new Limiter({ maxConcurrent: options.maxConcurrent });
		this.cache = new Map();
		this.inFlight = new Map();
		this.generation = 0;
	}

	/** The client auth, with the bearer token replaced when a request overrides it. */
	_authFor(override) {
		return override ? { ...this.auth, bearerToken: override.bearerToken } : this.auth;
	}

	/** The headers of the client with those of one request on top; names are compared without regard to case. */
	_headersFor(extra) {
		const merged = new Map();
		for (const source of [this.headers, extra]) {
			for (const [name, value] of Object.entries(source || {})) {
				merged.set(name.toLowerCase(), [name, value]);
			}
		}
		return merged;
	}

	/** Identity of a request for sharing and caching; contains credentials, never log it. */
	keyFor(req, override, headers) {
		const { username = "", password = "", bearerToken = "" } = this._authFor(override);
		const authKey = bearerToken ? "b:" + bearerToken : "u:" + username + ":" + password;
		const headersKey = [...this._headersFor(headers)]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, [, value]]) => key + "=" + value)
			.join("\n");
		return [normalize(req).method, req.url, req.body || "", authKey, headersKey].join("\n");
	}

	/**
	 * @param {{url: string, method?: string, body?: string}} req
	 * @param {{fresh?: boolean, auth?: {bearerToken: string}, headers?: Object<string, string>}} [options]
	 *   fresh: skip the cache lookup but still store the result
	 *   auth: replaces the client's bearer token for this request ("" turns it off)
	 *   headers: sent in addition to the headers of the client; the same name replaces them
	 * @returns {Promise<{status: number, body: string}>}
	 */
	read(req, { fresh = false, auth, headers } = {}) {
		const request = normalize(req);
		const key = this.keyFor(request, auth, headers);

		if (!fresh) {
			const hit = this.cache.get(key);
			if (hit && hit.expires > this.now()) {
				return Promise.resolve(hit.response);
			}
			this.cache.delete(key);
		}

		let pending = this.inFlight.get(key);
		if (!pending) {
			const generation = this.generation;
			pending = this._send(request, this.retries, auth, headers)
				.then((response) => {
					// A write that finished meanwhile may have made this response stale
					if (this.cacheTTL > 0 && generation === this.generation) {
						this.cache.set(key, { response, expires: this.now() + this.cacheTTL });
					}
					return response;
				})
				.finally(() => this.inFlight.delete(key));
			this.inFlight.set(key, pending);
		}
		return pending;
	}

	write(req, { auth, headers } = {}) {
		return this._send(normalize(req), 0, auth, headers).then((response) => {
			this.invalidate();
			return response;
		});
	}

	invalidate() {
		this.generation++;
		this.cache.clear();
	}

	_send(request, retries, override, headers) {
		const auth = this._authFor(override);
		const merged = this._headersFor(headers);
		return this.limiter.run(async () => {
			for (let attempt = 0; ; attempt++) {
				let response;
				try {
					response = await this._attempt(request, auth, merged);
				} catch (error) {
					if (attempt >= retries) throw error;
					await sleep(this.retryDelay * (attempt + 1));
					continue;
				}
				if (response.status < 200 || response.status > 299) throw httpError(response.status);
				return response;
			}
		});
	}

	async _attempt(request, auth, headers) {
		const authorization = buildAuthorization(auth);
		// Bearer is always sent up front; Basic can wait for a 401 challenge
		const immediately = Boolean(auth.bearerToken) || auth.immediately !== false;

		const response = await this._fetchOnce(request, immediately ? authorization : undefined, headers);
		if (!immediately && authorization && response.status === 401) {
			return this._fetchOnce(request, authorization, headers);
		}
		return response;
	}

	async _fetchOnce(request, authorization, headers = new Map()) {
		const init = { method: request.method, headers: {} };

		// A header that is configured by hand replaces the computed one, for example `Authorization: Token abc`
		if (authorization && !headers.has("authorization")) {
			init.headers.Authorization = authorization;
		}
		for (const [name, value] of headers.values()) {
			init.headers[name] = value;
		}
		if (this.timeout > 0) {
			init.signal = AbortSignal.timeout(this.timeout);
		}
		if (request.body && request.method !== "GET" && request.method !== "HEAD") {
			// A Buffer keeps fetch from adding a text/plain Content-Type (the old client sent none)
			init.body = Buffer.from(request.body);
		}

		try {
			const response = await this.fetch(request.url, init);
			return { status: response.status, body: await response.text() };
		} catch (error) {
			throw describeError(error, this.timeout);
		}
	}
}

function normalize(req) {
	return { url: req.url, method: (req.method || "GET").toUpperCase(), body: req.body || "" };
}

// The message has no URL, which may carry credentials in its query string
function httpError(status) {
	const error = new Error(`HTTP ${status}${STATUS_CODES[status] ? " " + STATUS_CODES[status] : ""}`);
	error.status = status;
	return error;
}

// Error messages must not contain the URL, which may carry credentials in its query string
function describeError(error, timeout) {
	if (error && error.name === "TimeoutError") {
		return new Error("Request timed out after " + timeout + "ms");
	}
	const detail = (error && error.cause && error.cause.message) || (error && error.message) || String(error);
	const described = new Error(detail);
	described.cause = error;
	return described;
}

module.exports = HttpClient;

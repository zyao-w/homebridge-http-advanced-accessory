const { INCONCLUSIVE } = require("./mappers/index.js");

/**
 * Runs the actions of one device: requests, mapper chains, fallbacks and error results.
 * It knows nothing about HomeKit; callers decide what to do with a value or an error.
 */
class ActionRunner {
	/**
	 * @param {{client: Object, log: Function, debug?: boolean, authError?: Error|null}} options
	 */
	constructor({ client, log, debug, authError }) {
		this.client = client;
		this.log = log;
		this.debug = debug;
		this.authError = authError || null;
	}

	debugLog(...args) {
		if (this.debug) {
			this.log(...args);
		}
	}

	/** Runs the value through the mapper chain. */
	applyMappers(mappers, value) {
		if (mappers && mappers.length > 0) {
			this.debugLog("Applying mappers on " + value);
			mappers.forEach((mapper, index) => {
				const mapped = mapper.map(value);
				this.debugLog("Mapper " + index + " mapped " + value + " to " + mapped);
				value = mapped;
			});

			this.debugLog("Mapping result is " + value);
		}

		return value;
	}

	// An unreadable token or header value fails the request instead of sending it without, or with Basic authentication
	_authProblem(action) {
		return this.authError || (action.auth && action.auth.error) || action.headersError || null;
	}

	_authOverride(action) {
		return action.auth ? { bearerToken: action.auth.bearerToken } : undefined;
	}

	/** Identity of a read request; actions with the same key can share one poll. Contains credentials. */
	pollKey(action) {
		return this.client.keyFor(
			{ url: action.url, method: action.httpMethod, body: action.body },
			this._authOverride(action),
			action.headers
		);
	}

	/** @returns {Promise<{status: number, body: string}>} */
	readRequest(action, { fresh = false } = {}) {
		const problem = this._authProblem(action);
		if (problem) {
			return Promise.reject(problem);
		}
		return this.client.read(
			{ url: action.url, method: action.httpMethod, body: action.body },
			{ fresh, auth: this._authOverride(action), headers: action.headers }
		);
	}

	/** @returns {Promise<{status: number, body: string}>} */
	writeRequest(action, url, body) {
		const problem = this._authProblem(action);
		if (problem) {
			return Promise.reject(problem);
		}
		return this.client.write(
			{ url, method: action.httpMethod, body },
			{ auth: this._authOverride(action), headers: action.headers }
		);
	}

	/** Reads an action and resolves to the value. Rejects when the request or the mapping fails. */
	async readValue(action, { fresh = false } = {}) {
		this.debugLog("getDispatch function called for url: %s", action.url);

		let response;
		try {
			response = await this.readRequest(action, { fresh });
		} catch (error) {
			return this.recoverFromError(action, error);
		}
		return this.mapResponse(action, response.body);
	}

	/** Resolves to the action's resultOnError, or rethrows the error when there is none. */
	async recoverFromError(action, error) {
		if (action.resultOnError != null) {
			this.debugLog("GetState function failed BUT using resultOnError=%s: %s", action.resultOnError, error.message);
			return action.resultOnError;
		}
		throw error;
	}

	/** Maps a response body to the value, following inconclusive fallbacks. */
	async mapResponse(action, body) {
		this.debugLog("received response from action: %s", action.url);

		const value = this.applyMappers(action.mappers, body);
		if (value == INCONCLUSIVE) {
			this.log(`Inconclusive mapping of response "${body}"`);
			if (action.inconclusive) {
				this.debugLog("Response inconclusive and trying the action specified for this condition.");
				return this.readValue(action.inconclusive);
			}
			this.debugLog("Response inconclusive with no further action specified for this condition.");
			throw new Error("Inconclusive response and no fallback action");
		}

		this.debugLog("We have a value: %s, int: %d", value, parseInt(value));
		return value;
	}
}

module.exports = ActionRunner;

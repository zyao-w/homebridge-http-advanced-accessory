const { createActions } = require("./actions.js");
const { parseConfig } = require("./config.js");
const HttpClient = require("./http/client.js");
const Poller = require("./poller.js");
const { INCONCLUSIVE } = require("./mappers/index.js");
const { renderTemplate } = require("./template.js");

const INTEGER_FORMATS = ["int", "uint16", "uint8", "uint32", "uint64"];

let deprecationLogged = false;

const compactName = (characteristic) => characteristic.displayName.replace(/\s/g, "");

class HttpAdvancedAccessory {
	/**
	 * @param {Function} log Homebridge logger
	 * @param {Object} config The accessory configuration
	 * @param {{hap: Object}} api Homebridge API
	 */
	constructor(log, config, api) {
		this.log = log;
		this.hap = api.hap;

		const options = parseConfig(config);
		this.name = options.name;
		this.service = options.service;
		this.optionCharacteristic = options.optionCharacteristic;
		this.props = options.props;
		this.forceRefreshDelay = options.forceRefreshDelay;
		this.setterDelay = options.setterDelay;
		this.debug = options.debug;
		this.auth = options.auth;
		this.authError = options.authError;

		this.state = {};
		this.pollSubscriptions = {};
		this.setTimers = new Map();

		this.actions = createActions(options.urls, {
			state: this.state,
			warn: (message) => this.log("WARNING: " + message),
		});

		if (this.authError) {
			this.log("ERROR: " + this.authError.message);
		}

		this.client = new HttpClient({ auth: this.auth, ...options.http });
		this.poller = new Poller({ log: (message) => this.debugLog(message) });

		if (!deprecationLogged) {
			deprecationLogged = true;
			this.log(
				'NOTICE: configuring this plugin as an accessory ("accessory": "HttpAdvancedAccessory") is deprecated and will be replaced by a Dynamic Platform in 2.0.0.'
			);
		}
	}

	/** Logs only when the debug option is on. */
	debugLog(...args) {
		if (this.debug) {
			this.log(...args);
		}
	}

	/**
	 * Performs a read request. Identical in-flight reads are shared and responses are cached for `cacheTTL`.
	 * @returns {Promise<{status: number, body: string}>}
	 */
	readRequest(action, options) {
		if (this.authError) {
			// Fail instead of silently falling back to Basic auth with empty credentials
			return Promise.reject(this.authError);
		}
		return this.client.read({ url: action.url, method: action.httpMethod, body: action.body }, options);
	}

	/**
	 * Performs a write request. Never shared, cached or retried.
	 * @returns {Promise<{status: number, body: string}>}
	 */
	writeRequest(url, body, httpMethod) {
		if (this.authError) {
			return Promise.reject(this.authError);
		}
		return this.client.write({ url, method: httpMethod, body });
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

	/** Reads an action and resolves to the characteristic value. */
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
		this.log("GetState function failed: %s", error.message);
		throw error;
	}

	/** Maps a response body to the characteristic value, following inconclusive fallbacks. */
	async mapResponse(action, body) {
		this.debugLog("received response from action: %s", action.url);

		const state = this.applyMappers(action.mappers, body);
		if (state == INCONCLUSIVE) {
			this.log(`Inconclusive mapping of response "${body}"`);
			if (action.inconclusive) {
				this.debugLog("Response inconclusive and trying the action specified for this condition.");
				return this.readValue(action.inconclusive);
			}
			this.debugLog("Response inconclusive with no further action specified for this condition.");
			throw new Error("Inconclusive response and no fallback action");
		}

		this.debugLog("We have a value: %s, int: %d", state, parseInt(state));
		return state;
	}

	handleGet(characteristic, callback) {
		const actionName = "get" + compactName(characteristic);
		if (actionName === "getName") {
			callback(null, this.name);
			return;
		}
		const action = this.actions[actionName];

		if (this.forceRefreshDelay === 0) {
			if (!action) {
				callback(null);
				return;
			}
			this.readValue(action)
				.then(
					(value) => {
						this.debugLog(actionName + " getter function returned with data: " + value);
						this.state[actionName] = value;
						characteristic.updateValue(value);
						callback(null, value);
					},
					(error) => callback(error)
				)
				.catch((error) => this.log("Unexpected error in getter: %s", error && error.message));
			return;
		}

		callback(null, this.state[actionName] ?? characteristic.value);
		this.startPolling(characteristic, actionName, action);
	}

	startPolling(characteristic, actionName, action) {
		if (this.pollSubscriptions[actionName] !== undefined) {
			this.debugLog(actionName + " returning cached data: " + this.state[actionName]);
			return;
		}
		if (action === undefined) {
			// Nothing to poll without a getter action
			return;
		}
		this.debugLog("creating new poller for " + actionName);

		const publish = (value) => {
			this.debugLog(actionName + " poller returned data: " + value);

			if (INTEGER_FORMATS.includes(characteristic.props.format)) value = parseInt(value);
			if (characteristic.props.format === "float") value = parseFloat(value);

			this.state[actionName] = value;
			characteristic.updateValue(value);
		};
		const failed = (error) => this.log("Poller errored: %s", error && error.message);

		// Actions that issue the same request share one poll
		const key = this.client.keyFor({ url: action.url, method: action.httpMethod, body: action.body });
		this.pollSubscriptions[actionName] = this.poller.subscribe(
			key,
			{
				poll: () => {
					this.debugLog("requested update for action " + actionName);
					return this.readRequest(action, { fresh: true });
				},
				intervalMs: this.forceRefreshDelay * 1000,
			},
			{
				onResult: (response) => this.mapResponse(action, response.body).then(publish).catch(failed),
				onError: (error) => this.recoverFromError(action, error).then(publish).catch(failed),
			}
		);
	}

	handleSet(characteristic, value, callback) {
		const name = compactName(characteristic);

		if (this.setterDelay === 0) {
			this.debugLog("updating " + name + " with value " + value);
			this.dispatchSet(characteristic, value, callback);
			return;
		}

		// Optimistic callback: with a delay HomeKit never sees errors of the request
		callback();

		this.debugLog("updating " + name + " with value " + value + " in " + this.setterDelay + "ms");
		if (this.setTimers.has(characteristic)) {
			clearTimeout(this.setTimers.get(characteristic));
			this.debugLog("clearing timeout for setter " + name);
		}
		this.setTimers.set(
			characteristic,
			setTimeout(() => {
				this.setTimers.delete(characteristic);
				this.dispatchSet(characteristic, value, null);
			}, this.setterDelay)
		);
	}

	dispatchSet(characteristic, value, callback) {
		const actionName = "set" + compactName(characteristic);
		this.debugLog("setDispatch:actionName:value: ", actionName, value);

		const action = this.actions[actionName];
		if (!action || !action.url) {
			if (callback) callback(null);
			return;
		}

		let url, body;
		try {
			const mappedValue = this.applyMappers(action.mappers, value);
			const scope = { value, state: this.state, mappedValue };
			url = renderTemplate(action.url, scope);
			body = action.body ? renderTemplate(action.body, scope) : action.body;
		} catch (error) {
			this.log("SetState function failed: %s", error.message);
			if (callback) callback(error);
			return;
		}

		this.writeRequest(url, body, action.httpMethod)
			.then(
				() => {
					// https://github.com/KhaosT/HAP-NodeJS/blob/master/lib/Characteristic.js#L34 setter callback takes only error as arg
					if (callback) callback();
				},
				(error) => {
					this.log("SetState function failed: %s", error.message);
					if (callback) callback(error);
				}
			)
			.catch((error) => this.log("Unexpected error in setter: %s", error && error.message));
	}

	bindCharacteristic(characteristic) {
		characteristic.on("get", (callback) => this.handleGet(characteristic, callback));
		characteristic.on("set", (value, callback) => this.handleSet(characteristic, value, callback));
	}

	identify(callback) {
		this.log("Identify requested!");
		callback(null);
	}

	getName(callback) {
		this.log("getName :", this.name);
		callback(null, this.name);
	}

	getServices() {
		const { Service, Characteristic } = this.hap;

		const informationService = new Service.AccessoryInformation();
		informationService
			.setCharacteristic(Characteristic.Manufacturer, "Custom Manufacturer")
			.setCharacteristic(Characteristic.Model, "HTTP Accessory Model")
			.setCharacteristic(Characteristic.SerialNumber, "HTTP Accessory Serial Number");

		// A throw here would take down every accessory of the bridge, so only this one is left out
		if (typeof Service[this.service] !== "function") {
			this.log(
				this.service === undefined
					? `ERROR: Accessory "${this.name}" has no "service" setting, it was not loaded.`
					: `ERROR: Accessory "${this.name}" has an unknown service "${this.service}", it was not loaded.`
			);
			return [informationService];
		}
		const service = new Service[this.service](this.name);

		const applyProps = (characteristic) => {
			const name = compactName(characteristic);
			if (name in this.props) {
				characteristic.setProps(this.props[name]);
			}
			return name;
		};

		for (const characteristic of service.characteristics) {
			applyProps(characteristic);
			this.bindCharacteristic(characteristic);
		}

		for (const characteristic of service.optionalCharacteristics) {
			const name = applyProps(characteristic);
			if (!this.optionCharacteristic.includes(name)) {
				continue;
			}
			this.bindCharacteristic(characteristic);
			service.addCharacteristic(characteristic);
		}

		return [informationService, service];
	}
}

module.exports = HttpAdvancedAccessory;

const ActionRunner = require("./runner.js");
const HttpClient = require("./http/client.js");
const Poller = require("./poller.js");
const { renderTemplate } = require("./template.js");

const INTEGER_FORMATS = ["int", "uint16", "uint8", "uint32", "uint64"];

// A failing poll is logged once, then reminded about at this interval until it recovers
const OUTAGE_REMINDER_MS = 5 * 60 * 1000;

function formatDuration(ms) {
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const compactName = (characteristic) => characteristic.displayName.replace(/\s/g, "");

/** Binds one normalized device to a HomeKit accessory. */
class DeviceController {
	/**
	 * @param {{device: Object, accessory: Object, api: Object, log: Function}} options
	 */
	constructor({ device, accessory, api, log }) {
		this.device = device;
		this.accessory = accessory;
		this.api = api;
		this.log = log;

		this.client = new HttpClient({ auth: device.auth, ...device.http });
		this.poller = new Poller({ log: (message) => this.debugLog(message) });
		this.runner = new ActionRunner({ client: this.client, log, debug: device.debug, authError: device.authError });
		this.setTimers = new Map();
		// Characteristics whose last poll failed; HomeKit reads them as a communication error until a poll succeeds
		this.pollFailures = new Set();
		// When each failing poll started and when it was last logged
		this.outages = new Map();
		this.unsubscribers = [];
	}

	debugLog(...args) {
		if (this.device.debug) {
			this.log(...args);
		}
	}

	_communicationError() {
		const { HapStatusError, HAPStatus } = this.api.hap;
		return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
	}

	/** Creates the service of the device and binds its characteristics. Throws on an unknown service. */
	start() {
		const { Service, Characteristic } = this.api.hap;
		const { device, accessory } = this;

		const ServiceType = Service[device.service];
		if (!ServiceType) {
			throw new Error(`Device "${device.name}" has an unknown service "${device.service}"`);
		}

		if (this.runner.authError) {
			this.log("ERROR: " + this.runner.authError.message);
		}

		const information =
			accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
		information
			.setCharacteristic(Characteristic.Manufacturer, device.information.manufacturer)
			.setCharacteristic(Characteristic.Model, device.information.model)
			.setCharacteristic(Characteristic.SerialNumber, device.information.serialNumber);

		// A cached accessory is rebuilt so that its service always matches the current configuration
		for (const existing of [...accessory.services]) {
			if (existing.UUID !== Service.AccessoryInformation.UUID) {
				accessory.removeService(existing);
			}
		}
		const service = accessory.addService(ServiceType, device.name);

		const entries = new Map(device.characteristics.map((entry) => [entry.name, entry]));
		const bound = new Set();
		const bind = (characteristic) => {
			bound.add(compactName(characteristic));
			this._bind(characteristic, entries.get(compactName(characteristic)));
		};

		for (const characteristic of [...service.characteristics]) {
			bind(characteristic);
		}
		for (const characteristic of [...service.optionalCharacteristics]) {
			if (device.optionCharacteristic.includes(compactName(characteristic))) {
				bind(characteristic);
				service.addCharacteristic(characteristic);
			}
		}

		for (const name of entries.keys()) {
			if (!bound.has(name)) {
				this.log(
					`WARNING: the service ${device.service} has no characteristic "${name}" to bind, or it is not listed in optionCharacteristic`
				);
			}
		}
	}

	_bind(characteristic, entry) {
		const name = compactName(characteristic);

		if (entry && Object.keys(entry.props).length > 0) {
			characteristic.setProps(entry.props);
		}
		characteristic.onGet(() => this._get(name, entry, characteristic));
		characteristic.onSet((value) => this._set(name, entry, characteristic, value));

		if (entry && entry.get && this.device.forceRefreshDelay > 0) {
			this._startPolling(name, entry.get, characteristic);
		}
	}

	_publish(name, characteristic, value) {
		if (INTEGER_FORMATS.includes(characteristic.props.format)) value = parseInt(value);
		if (characteristic.props.format === "float") value = parseFloat(value);

		this.device.state[name] = value;
		this.pollFailures.delete(name);
		characteristic.updateValue(value);
		return value;
	}

	async _get(name, entry, characteristic) {
		if (!entry || !entry.get) {
			return name === "Name" ? this.device.name : characteristic.value;
		}

		// Polled characteristics answer from the last polled value
		if (this.device.forceRefreshDelay > 0) {
			if (this.pollFailures.has(name)) {
				throw this._communicationError();
			}
			return this.device.state[name] ?? characteristic.value;
		}

		try {
			const value = await this.runner.readValue(entry.get);
			this.debugLog(name + " getter function returned with data: " + value);
			return this._publish(name, characteristic, value);
		} catch (error) {
			this.log("GetState function failed: %s", error.message);
			throw this._communicationError();
		}
	}

	_startPolling(name, action, characteristic) {
		this.debugLog("creating new poller for " + name);

		const publish = (value) => {
			this.debugLog(name + " poller returned data: " + value);
			const outage = this.outages.get(name);
			if (outage) {
				this.outages.delete(name);
				this.log("Poller for %s recovered after %s", name, formatDuration(Date.now() - outage.since));
			}
			this._publish(name, characteristic, value);
		};
		const failed = (error) => {
			this.pollFailures.add(name);
			const message = error && error.message;
			const now = Date.now();
			const outage = this.outages.get(name);
			if (!outage) {
				this.outages.set(name, { since: now, lastLogged: now });
				this.log("Poller for %s errored: %s", name, message);
			} else if (now - outage.lastLogged >= OUTAGE_REMINDER_MS) {
				outage.lastLogged = now;
				this.log("Poller for %s is still failing after %s: %s", name, formatDuration(now - outage.since), message);
			}
		};

		// Actions that issue the same request share one poll
		this.unsubscribers.push(
			this.poller.subscribe(
				this.runner.pollKey(action),
				{
					poll: () => {
						this.debugLog("requested update for action " + name);
						return this.runner.readRequest(action, { fresh: true });
					},
					intervalMs: this.device.forceRefreshDelay * 1000,
				},
				{
					onResult: (response) => this.runner.mapResponse(action, response.body).then(publish).catch(failed),
					onError: (error) => this.runner.recoverFromError(action, error).then(publish).catch(failed),
				}
			)
		);
	}

	async _set(name, entry, characteristic, value) {
		if (!entry || !entry.set) {
			return;
		}

		if (this.device.setterDelay === 0) {
			this.debugLog("updating " + name + " with value " + value);
			await this._dispatchSet(name, entry.set, value);
			return;
		}

		// Optimistic answer: with a delay HomeKit never sees errors of the request
		this.debugLog("updating " + name + " with value " + value + " in " + this.device.setterDelay + "ms");
		if (this.setTimers.has(characteristic)) {
			clearTimeout(this.setTimers.get(characteristic));
			this.debugLog("clearing timeout for setter " + name);
		}
		this.setTimers.set(
			characteristic,
			setTimeout(() => {
				this.setTimers.delete(characteristic);
				this._dispatchSet(name, entry.set, value).catch(() => {});
			}, this.device.setterDelay)
		);
	}

	async _dispatchSet(name, action, value) {
		this.debugLog("setDispatch:actionName:value: ", name, value);

		try {
			const mappedValue = this.runner.applyMappers(action.mappers, value);
			const scope = { value, state: this.device.state, mappedValue };
			const unsafe = this.device.allowUnsafeEval;
			const url = renderTemplate(action.url, scope, { unsafe });
			const body = action.body ? renderTemplate(action.body, scope, { unsafe }) : action.body;
			await this.runner.writeRequest(action, url, body);
		} catch (error) {
			this.log("SetState function failed: %s", error.message);
			throw this._communicationError();
		}

		this.device.state[name] = value;
	}

	/** Stops polling and cancels delayed set requests. */
	stop() {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
		for (const timer of this.setTimers.values()) clearTimeout(timer);
		this.setTimers.clear();
	}
}

module.exports = DeviceController;

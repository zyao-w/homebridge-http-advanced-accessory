const ActionRunner = require("./runner.js");
const HttpClient = require("./http/client.js");
const Poller = require("./poller.js");
const { INCONCLUSIVE } = require("./mappers/index.js");
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

	/** Creates the services of the device and binds their characteristics. Throws on an unknown service. */
	start() {
		const { Service, Characteristic } = this.api.hap;
		const { device, accessory } = this;

		// Every service type is checked first, so a mistake leaves the cached accessory as it was
		const ServiceType = Service[device.service];
		if (!ServiceType) {
			throw new Error(`Device "${device.name}" has an unknown service "${device.service}"`);
		}
		const extraTypes = device.additionalServices.map((extra) => {
			if (!Service[extra.service]) {
				throw new Error(`Device "${device.name}" service "${extra.id}" has an unknown service "${extra.service}"`);
			}
			return Service[extra.service];
		});

		if (this.runner.authError) {
			this.log("ERROR: " + this.runner.authError.message);
		}

		const information =
			accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
		information
			.setCharacteristic(Characteristic.Manufacturer, device.information.manufacturer)
			.setCharacteristic(Characteristic.Model, device.information.model)
			.setCharacteristic(Characteristic.SerialNumber, device.information.serialNumber);

		// A cached accessory is rebuilt so that its services always match the current configuration
		for (const existing of [...accessory.services]) {
			if (existing.UUID !== Service.AccessoryInformation.UUID) {
				accessory.removeService(existing);
			}
		}

		this._bindService(accessory.addService(ServiceType, device.name), {
			displayName: device.name,
			serviceType: device.service,
			characteristics: device.characteristics,
			optionCharacteristic: device.optionCharacteristic,
			state: device.state,
		});
		// The subtype keeps the identity of a service when the others around it change
		device.additionalServices.forEach((extra, index) => {
			this._bindService(accessory.addService(extraTypes[index], extra.name, extra.id), {
				id: extra.id,
				displayName: extra.name,
				serviceType: extra.service,
				characteristics: extra.characteristics,
				optionCharacteristic: extra.optionCharacteristic,
				state: extra.state,
			});
		});
	}

	/**
	 * @param {Object} service The HAP service
	 * @param {{id?: string, displayName: string, serviceType: string, characteristics: Object[], optionCharacteristic: string[], state: Object}} bucket
	 *   `state` is where the values of this service are kept; `id` is set for an additional service
	 */
	_bindService(service, bucket) {
		const entries = new Map(bucket.characteristics.map((entry) => [entry.name, entry]));
		const bound = new Set();
		// The slots of this service, to tell whether any of its reads is failing
		bucket.keys = new Set();
		const bind = (characteristic) => {
			bound.add(compactName(characteristic));
			this._bind(characteristic, entries.get(compactName(characteristic)), bucket);
		};

		for (const characteristic of [...service.characteristics]) {
			bind(characteristic);
		}
		for (const characteristic of [...service.optionalCharacteristics]) {
			if (bucket.optionCharacteristic.includes(compactName(characteristic))) {
				bind(characteristic);
				service.addCharacteristic(characteristic);
			}
		}
		if (this.device.statusFault) {
			this._attachFault(service, bucket, bound);
		}

		for (const name of entries.keys()) {
			if (!bound.has(name)) {
				const where = bucket.id
					? `service "${bucket.id}" (${bucket.serviceType})`
					: `the service ${bucket.serviceType}`;
				this.log(
					`WARNING: ${where} has no characteristic "${name}" to bind, or it is not listed in optionCharacteristic`
				);
			}
		}
	}

	_bind(characteristic, entry, bucket) {
		const name = compactName(characteristic);
		// `key` tells apart characteristics with the same name in different services
		const slot = {
			name,
			key: bucket.id ? `${bucket.id}.${name}` : name,
			state: bucket.state,
			displayName: bucket.displayName,
			bucket,
		};
		bucket.keys.add(slot.key);

		if (entry && Object.keys(entry.props).length > 0) {
			characteristic.setProps(entry.props);
		}
		characteristic.onGet(() => this._get(slot, entry, characteristic));
		characteristic.onSet((value) => this._set(slot, entry, characteristic, value));

		if (entry && entry.get && this.device.forceRefreshDelay > 0) {
			this._startPolling(slot, entry.get, characteristic);
		}
	}

	/**
	 * Adds the Status Fault characteristic to a service that offers it. A characteristic that the configuration maps
	 * itself is left alone.
	 */
	_attachFault(service, bucket, bound) {
		const where = bucket.id ? `service "${bucket.id}" (${bucket.serviceType})` : `the service ${bucket.serviceType}`;
		if (bound.has("StatusFault")) {
			return;
		}
		const offered = [...service.characteristics, ...service.optionalCharacteristics].find(
			(characteristic) => compactName(characteristic) === "StatusFault"
		);
		if (!offered) {
			this.log(`WARNING: ${where} has no Status Fault characteristic, so statusFault does not apply to it`);
			return;
		}
		service.addCharacteristic(offered);
		bucket.fault = offered;
		offered.updateValue(this.api.hap.Characteristic.StatusFault.NO_FAULT);
	}

	/** Shows the service as faulty while any of its characteristics fails to read. */
	_updateFault(bucket) {
		if (!bucket.fault) return;
		const { StatusFault } = this.api.hap.Characteristic;
		const failing = [...bucket.keys].some((key) => this.pollFailures.has(key));
		bucket.fault.updateValue(failing ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
	}

	_publish(slot, characteristic, value) {
		if (INTEGER_FORMATS.includes(characteristic.props.format)) value = parseInt(value);
		if (characteristic.props.format === "float") value = parseFloat(value);

		slot.state[slot.name] = value;
		this.pollFailures.delete(slot.key);
		characteristic.updateValue(value);
		this._updateFault(slot.bucket);
		return value;
	}

	async _get(slot, entry, characteristic) {
		if (!entry || !entry.get) {
			return slot.name === "Name" ? slot.displayName : characteristic.value;
		}

		// Polled characteristics answer from the last polled value
		if (this.device.forceRefreshDelay > 0) {
			if (this.pollFailures.has(slot.key)) {
				throw this._communicationError();
			}
			return slot.state[slot.name] ?? characteristic.value;
		}

		try {
			const value = await this.runner.readValue(entry.get);
			this.debugLog(slot.key + " getter function returned with data: " + value);
			return this._publish(slot, characteristic, value);
		} catch (error) {
			this.log("GetState function failed: %s", error.message);
			this.pollFailures.add(slot.key);
			this._updateFault(slot.bucket);
			throw this._communicationError();
		}
	}

	_startPolling(slot, action, characteristic) {
		const key = slot.key;
		this.debugLog("creating new poller for " + key);

		const publish = (value) => {
			this.debugLog(key + " poller returned data: " + value);
			const outage = this.outages.get(key);
			if (outage) {
				this.outages.delete(key);
				this.log("Poller for %s recovered after %s", key, formatDuration(Date.now() - outage.since));
			}
			this._publish(slot, characteristic, value);
		};
		const failed = (error) => {
			this.pollFailures.add(key);
			this._updateFault(slot.bucket);
			const message = error && error.message;
			const now = Date.now();
			const outage = this.outages.get(key);
			if (!outage) {
				this.outages.set(key, { since: now, lastLogged: now });
				this.log("Poller for %s errored: %s", key, message);
			} else if (now - outage.lastLogged >= OUTAGE_REMINDER_MS) {
				outage.lastLogged = now;
				this.log("Poller for %s is still failing after %s: %s", key, formatDuration(now - outage.since), message);
			}
		};

		// Actions that issue the same request share one poll
		this.unsubscribers.push(
			this.poller.subscribe(
				this.runner.pollKey(action),
				{
					poll: () => {
						this.debugLog("requested update for action " + key);
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

	async _set(slot, entry, characteristic, value) {
		if (!entry || !entry.set) {
			return;
		}

		const name = slot.key;
		if (this.device.setterDelay === 0) {
			this.debugLog("updating " + name + " with value " + value);
			await this._dispatchSet(slot, entry.set, value);
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
				this._dispatchSet(slot, entry.set, value).catch(() => {});
			}, this.device.setterDelay)
		);
	}

	async _dispatchSet(slot, action, value) {
		this.debugLog("setDispatch:actionName:value: ", slot.key, value);

		try {
			const mappedValue = this.runner.applyMappers(action.mappers, value);
			if (mappedValue === INCONCLUSIVE) {
				throw new Error(`The mappers could not convert the value ${value}, nothing was sent`);
			}
			const scope = { value, state: this.device.state, mappedValue };
			const unsafe = this.device.allowUnsafeEval;
			const url = renderTemplate(action.url, scope, { unsafe });
			const body = action.body ? renderTemplate(action.body, scope, { unsafe }) : action.body;
			await this.runner.writeRequest(action, url, body);
		} catch (error) {
			this.log("SetState function failed: %s", error.message);
			throw this._communicationError();
		}

		slot.state[slot.name] = value;
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

const fs = require("fs");
const path = require("path");

const STATUS_VERSION = 1;
const STATUS_DIRECTORY = "homebridge-http-advanced-accessory";
const STATUS_FILE = "status.json";

// A change of state is rare and tells what is wrong, so it is written soon. A new value is only news for the page,
// and sensors report one at every poll, so values are written at most this often to spare the storage (an SD card).
const TRANSITION_DELAY_MS = 5000;
const VALUE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_VALUE_LENGTH = 100;
const MAX_ERROR_LENGTH = 200;

/** Where the plugin keeps the status of its devices inside the storage of Homebridge. */
const statusFilePath = (storagePath) => path.join(storagePath, STATUS_DIRECTORY, STATUS_FILE);

function shorten(value, limit) {
	let text;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch (error) {
			text = String(value);
		}
	}
	text = text === undefined ? String(value) : text;
	return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** What a device reports about itself; every method is safe to call when nothing is recorded. */
const NO_STATUS = { track() {}, ok() {}, fail() {} };

/**
 * Keeps the state of the devices and writes it to a file that the settings page reads, since the page cannot ask the
 * running plugin. The file holds the state of every read (working, failing since when, the last value and error) and
 * never a token, a header, a URL or a response: values and error messages are cut short.
 */
class StatusReporter {
	/**
	 * @param {{storagePath?: string, log?: Function, now?: () => number}} [options] Without a storage path nothing is written
	 */
	constructor({ storagePath, log, now } = {}) {
		this.file = storagePath ? statusFilePath(storagePath) : null;
		this.log = log || (() => {});
		this.now = now || Date.now;
		this.startedAt = this.now();
		this.devices = new Map();
		this.timer = null;
		this.due = 0;
		this.lastWrite = 0;
		this.lastContent = null;
		this.warned = false;
		this.stopped = false;
	}

	/** Registers a device that runs. Returns what the device records its reads with. */
	device({ id, name, enabled, polling }) {
		const entry = {
			id,
			name,
			enabled: Boolean(enabled),
			loaded: true,
			polling: Boolean(polling),
			characteristics: new Map(),
		};
		this.devices.set(id, entry);
		this._schedule(this.now() + TRANSITION_DELAY_MS);

		return {
			track: (key) => this._slot(entry, key),
			ok: (key, value) => this._ok(entry, key, value),
			fail: (key, message) => this._fail(entry, key, message),
		};
	}

	/** Registers a device that could not be loaded, with what is wrong with it. */
	unloaded({ id, name, error }) {
		this.devices.set(id, {
			id,
			name,
			enabled: true,
			loaded: false,
			polling: false,
			error: shorten(error || "", MAX_ERROR_LENGTH),
			characteristics: new Map(),
		});
		this._schedule(this.now() + TRANSITION_DELAY_MS);
	}

	_slot(entry, key) {
		let slot = entry.characteristics.get(key);
		if (!slot) {
			slot = { key, state: "idle" };
			entry.characteristics.set(key, slot);
		}
		return slot;
	}

	_ok(entry, key, value) {
		const slot = this._slot(entry, key);
		const now = this.now();
		const text = shorten(value, MAX_VALUE_LENGTH);
		const changedState = slot.state !== "ok";

		slot.state = "ok";
		slot.lastSuccessAt = now;
		slot.lastValueAt = now;
		delete slot.failingSince;
		delete slot.lastError;
		const changedValue = slot.lastValue !== text;
		slot.lastValue = text;

		if (changedState) this._schedule(now + TRANSITION_DELAY_MS);
		else if (changedValue) this._schedule(Math.max(now, this.lastWrite + VALUE_INTERVAL_MS));
	}

	_fail(entry, key, message) {
		const slot = this._slot(entry, key);
		const now = this.now();
		const text = shorten(message || "Failed", MAX_ERROR_LENGTH);
		const changedState = slot.state !== "failing";

		slot.state = "failing";
		if (changedState) slot.failingSince = now;
		const changedMessage = slot.lastError !== text;
		slot.lastError = text;

		// A message that varies from one failure to the next must not turn into a write at every poll
		if (changedState) this._schedule(now + TRANSITION_DELAY_MS);
		else if (changedMessage) this._schedule(Math.max(now, this.lastWrite + VALUE_INTERVAL_MS));
	}

	/** Writes at `at` unless a write is already planned for sooner. */
	_schedule(at) {
		if (!this.file || this.stopped) return;
		if (this.timer && this.due <= at) return;
		clearTimeout(this.timer);
		this.due = at;
		this.timer = setTimeout(() => this.flush(), Math.max(0, at - this.now()));
		if (this.timer.unref) this.timer.unref();
	}

	_snapshot() {
		return {
			version: STATUS_VERSION,
			pid: process.pid,
			startedAt: this.startedAt,
			stopped: this.stopped,
			devices: [...this.devices.values()].map((entry) => ({
				id: entry.id,
				name: entry.name,
				enabled: entry.enabled,
				loaded: entry.loaded,
				polling: entry.polling,
				...(entry.error ? { error: entry.error } : {}),
				characteristics: [...entry.characteristics.values()],
			})),
		};
	}

	/** Writes the file now, unless nothing changed since the last write. */
	flush() {
		clearTimeout(this.timer);
		this.timer = null;
		if (!this.file) return;

		const snapshot = this._snapshot();
		const content = JSON.stringify(snapshot);
		if (content === this.lastContent) return;

		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// A file that is written under another name and then renamed is never seen half written
			const temporary = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify({ ...snapshot, updatedAt: this.now() }));
			fs.renameSync(temporary, this.file);
			this.lastContent = content;
			this.lastWrite = this.now();
		} catch (error) {
			if (!this.warned) {
				this.warned = true;
				this.log(
					`WARNING: the status of the devices cannot be written, so the settings page will not show it: ${error.message}`
				);
			}
		}
	}

	/** Writes the last state and marks the plugin as stopped. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.flush();
	}
}

module.exports = {
	StatusReporter,
	NO_STATUS,
	statusFilePath,
	STATUS_VERSION,
	TRANSITION_DELAY_MS,
	VALUE_INTERVAL_MS,
	MAX_VALUE_LENGTH,
	MAX_ERROR_LENGTH,
};

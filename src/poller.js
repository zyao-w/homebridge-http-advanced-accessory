/**
 * Polls a source on an interval and fans each outcome out to every subscriber of the same key,
 * so several characteristics backed by one URL cost a single request per interval.
 * The next poll is scheduled after the previous one completes, so polls never overlap.
 */
class Poller {
	/** @param {{log?: Function}} [options] */
	constructor(options = {}) {
		this.log = options.log || (() => {});
		this.entries = new Map();
	}

	/**
	 * @param {string} key Subscribers with the same key share one poll
	 * @param {{poll: () => Promise<*>, intervalMs: number}} source
	 * @param {{onResult: Function, onError: Function}} subscriber
	 * @returns {Function} unsubscribe
	 */
	subscribe(key, source, subscriber) {
		let entry = this.entries.get(key);

		if (!entry) {
			entry = {
				poll: source.poll,
				intervalMs: source.intervalMs,
				subscribers: new Set(),
				timer: null,
				stopped: false,
				last: null,
			};
			this.entries.set(key, entry);
			entry.subscribers.add(subscriber);
			this._run(entry);
		} else {
			entry.intervalMs = Math.min(entry.intervalMs, source.intervalMs);
			entry.subscribers.add(subscriber);
			if (entry.last) {
				// A late subscriber should not have to wait a whole interval for its first value
				const last = entry.last;
				Promise.resolve().then(() => {
					if (entry.subscribers.has(subscriber)) this._deliver(subscriber, last);
				});
			}
		}

		return () => {
			entry.subscribers.delete(subscriber);
			if (entry.subscribers.size === 0) {
				entry.stopped = true;
				clearTimeout(entry.timer);
				if (this.entries.get(key) === entry) this.entries.delete(key);
			}
		};
	}

	async _run(entry) {
		let outcome;
		try {
			outcome = { ok: true, value: await entry.poll() };
		} catch (error) {
			outcome = { ok: false, error };
		}

		if (entry.stopped) return;

		entry.last = outcome;
		for (const subscriber of [...entry.subscribers]) {
			this._deliver(subscriber, outcome);
		}

		if (entry.stopped) return;
		entry.timer = setTimeout(() => this._run(entry), entry.intervalMs);
		if (entry.timer.unref) entry.timer.unref();
	}

	_deliver(subscriber, outcome) {
		try {
			if (outcome.ok) {
				subscriber.onResult(outcome.value);
			} else {
				subscriber.onError(outcome.error);
			}
		} catch (error) {
			this.log("Poller subscriber failed: " + (error && error.message));
		}
	}
}

module.exports = Poller;

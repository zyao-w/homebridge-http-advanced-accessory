const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	StatusReporter,
	statusFilePath,
	TRANSITION_DELAY_MS,
	VALUE_INTERVAL_MS,
	MAX_VALUE_LENGTH,
	MAX_ERROR_LENGTH,
} = require("../src/status.js");

let directory;
let clock;
const now = () => clock;

beforeEach(() => {
	jest.useFakeTimers();
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
	clock = 1_000_000;
});

afterEach(() => {
	jest.useRealTimers();
	fs.rmSync(directory, { recursive: true, force: true });
});

const reporter = (options = {}) => new StatusReporter({ storagePath: directory, now, ...options });
const file = () => statusFilePath(directory);
const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));
const exists = () => fs.existsSync(file());
const writes = () => jest.spyOn(fs, "renameSync");

/** Moves the clock and the timers together, since the writer plans by the clock it is given. */
async function advance(ms) {
	clock += ms;
	await jest.advanceTimersByTimeAsync(ms);
}

const handleOf = (status, extra = {}) =>
	status.device({ id: "uuid-1", name: "Pump", enabled: true, polling: true, ...extra });

describe("the status file", () => {
	test("is inside the storage directory of Homebridge", () => {
		expect(file()).toBe(path.join(directory, "homebridge-http-advanced-accessory", "status.json"));
	});

	test("holds the devices, their reads and the process that writes it", () => {
		const status = reporter();
		const handle = handleOf(status);
		handle.track("On");
		handle.track("Brightness");
		handle.ok("On", "1");
		status.flush();

		const written = read();
		expect(written).toMatchObject({ version: 1, pid: process.pid, startedAt: 1_000_000, stopped: false });
		expect(written.updatedAt).toBe(clock);
		expect(written.devices).toEqual([
			{
				id: "uuid-1",
				name: "Pump",
				enabled: true,
				loaded: true,
				polling: true,
				characteristics: [
					{ key: "On", state: "ok", lastValue: "1", lastValueAt: clock, lastSuccessAt: clock },
					{ key: "Brightness", state: "idle" },
				],
			},
		]);
	});

	test("lists a device that could not be loaded with the reason", () => {
		const status = reporter();
		status.unloaded({ id: "uuid-2", name: "Broken", error: "has no service" });
		status.flush();
		expect(read().devices).toEqual([
			{
				id: "uuid-2",
				name: "Broken",
				enabled: true,
				loaded: false,
				polling: false,
				error: "has no service",
				characteristics: [],
			},
		]);
	});

	test("tells that a device is disabled", () => {
		const status = reporter();
		handleOf(status, { enabled: false, polling: false });
		status.flush();
		expect(read().devices[0]).toMatchObject({ enabled: false, polling: false });
	});

	test("is not written without a storage directory", () => {
		const status = new StatusReporter({ now });
		const handle = handleOf(status);
		handle.ok("On", "1");
		expect(() => status.flush()).not.toThrow();
		expect(exists()).toBe(false);
	});

	test("replaces the file in one step and leaves no temporary file behind", () => {
		const status = reporter();
		handleOf(status).ok("On", "1");
		status.flush();
		expect(fs.readdirSync(path.dirname(file()))).toEqual(["status.json"]);
	});
});

describe("what is recorded", () => {
	test("a failure records since when and why, and the next success clears them", async () => {
		const status = reporter();
		const handle = handleOf(status);
		handle.ok("On", "1");
		await advance(1000);
		handle.fail("On", "ECONNREFUSED");
		status.flush();
		expect(read().devices[0].characteristics[0]).toEqual({
			key: "On",
			state: "failing",
			lastValue: "1",
			lastValueAt: 1_000_000,
			// the last time it worked, which is what the page needs when it shows a failure
			lastSuccessAt: 1_000_000,
			failingSince: 1_001_000,
			lastError: "ECONNREFUSED",
		});

		await advance(1000);
		handle.fail("On", "ECONNREFUSED");
		status.flush();
		expect(read().devices[0].characteristics[0].failingSince).toBe(1_001_000);

		handle.ok("On", "2");
		status.flush();
		const recovered = read().devices[0].characteristics[0];
		expect(recovered.state).toBe("ok");
		expect(recovered).not.toHaveProperty("failingSince");
		expect(recovered).not.toHaveProperty("lastError");
	});

	test("values and errors are cut short", () => {
		const status = reporter();
		const handle = handleOf(status);
		handle.ok("A", "x".repeat(500));
		handle.fail("B", "y".repeat(500));
		handle.ok("C", { nested: [1, 2] });
		status.flush();
		const [a, b, c] = read().devices[0].characteristics;
		expect(a.lastValue).toHaveLength(MAX_VALUE_LENGTH + 1);
		expect(b.lastError).toHaveLength(MAX_ERROR_LENGTH + 1);
		expect(c.lastValue).toBe('{"nested":[1,2]}');
	});

	test("a failure without a message is still recorded", () => {
		const status = reporter();
		handleOf(status).fail("On", undefined);
		status.flush();
		expect(read().devices[0].characteristics[0]).toMatchObject({ state: "failing", lastError: "Failed" });
	});
});

describe("when it is written", () => {
	test("a change of state is written soon, and several changes make one write", async () => {
		const status = reporter();
		const renamed = writes();
		const handle = handleOf(status);
		handle.ok("On", "1");
		handle.ok("Brightness", "50");
		expect(exists()).toBe(false);

		await advance(TRANSITION_DELAY_MS);
		expect(renamed).toHaveBeenCalledTimes(1);
		expect(read().devices[0].characteristics.map((c) => c.state)).toEqual(["ok", "ok"]);
		renamed.mockRestore();
	});

	test("a failure is written soon even when the last write was a moment ago", async () => {
		const status = reporter();
		const handle = handleOf(status);
		handle.ok("On", "1");
		await advance(TRANSITION_DELAY_MS);
		handle.fail("On", "down");
		await advance(TRANSITION_DELAY_MS);
		expect(read().devices[0].characteristics[0].state).toBe("failing");
	});

	test("a value that changes at every poll is written once in a while, not at every poll", async () => {
		const status = reporter();
		const renamed = writes();
		const handle = handleOf(status);
		handle.ok("T", "20");
		await advance(TRANSITION_DELAY_MS);
		expect(renamed).toHaveBeenCalledTimes(1);

		// A sensor that reports a new value every 30 seconds for an hour
		for (let i = 1; i <= 120; i++) {
			handle.ok("T", String(20 + i));
			await advance(30_000);
		}
		// one write per VALUE_INTERVAL_MS at most
		const hour = 120 * 30_000;
		expect(renamed.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(hour / VALUE_INTERVAL_MS));
		expect(renamed.mock.calls.length).toBeGreaterThan(1);
		renamed.mockRestore();
	});

	test("a value that stays the same is not written again", async () => {
		const status = reporter();
		const renamed = writes();
		const handle = handleOf(status);
		handle.ok("T", "20");
		await advance(TRANSITION_DELAY_MS);
		for (let i = 0; i < 20; i++) {
			handle.ok("T", "20");
			await advance(60_000);
		}
		expect(renamed).toHaveBeenCalledTimes(1);
		renamed.mockRestore();
	});

	test("a message that changes at every failure does not make a write at every poll", async () => {
		const status = reporter();
		const renamed = writes();
		const handle = handleOf(status);
		handle.fail("T", "attempt 0");
		await advance(TRANSITION_DELAY_MS);
		for (let i = 1; i <= 20; i++) {
			handle.fail("T", `attempt ${i}`);
			await advance(10_000);
		}
		expect(renamed.mock.calls.length).toBeLessThanOrEqual(2);
		renamed.mockRestore();
	});

	test("stopping writes the last state and marks the plugin as stopped", () => {
		const status = reporter();
		handleOf(status).ok("On", "1");
		status.stop();
		expect(read()).toMatchObject({ stopped: true });
		expect(read().devices[0].characteristics[0].state).toBe("ok");
		// nothing is planned after it
		status.stop();
	});
});

describe("when it cannot be written", () => {
	test("warns once and keeps going", async () => {
		const log = jest.fn();
		const status = reporter({ log });
		const failing = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		handleOf(status).ok("On", "1");
		status.flush();
		status.flush();
		handleOf(status, { id: "uuid-2", name: "Other" }).ok("On", "1");
		status.flush();
		failing.mockRestore();

		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][0]).toContain("EACCES");
	});
});

describe("what it never contains", () => {
	test("has no token, header value, URL or response, because the reporter is only given values and messages", () => {
		const status = reporter();
		const handle = handleOf(status);
		handle.ok("On", "1");
		handle.fail("Brightness", "HTTP 401 Unauthorized");
		status.flush();
		const text = fs.readFileSync(file(), "utf8");
		for (const secret of ["Bearer", "Authorization", "http://", "token", "password"]) {
			expect(text).not.toContain(secret);
		}
	});
});

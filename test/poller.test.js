const Poller = require("../src/poller.js");

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function subscriber() {
	return { onResult: jest.fn(), onError: jest.fn() };
}

test("polls immediately and shares one poll between subscribers of a key", async () => {
	const poller = new Poller();
	const poll = jest.fn(async () => "v");
	const a = subscriber();
	const b = subscriber();
	const stopA = poller.subscribe("k", { poll, intervalMs: 1000 }, a);
	const stopB = poller.subscribe("k", { poll, intervalMs: 1000 }, b);
	await jest.advanceTimersByTimeAsync(0);
	expect(poll).toHaveBeenCalledTimes(1);
	expect(a.onResult).toHaveBeenCalledWith("v");
	expect(b.onResult).toHaveBeenCalledWith("v");
	stopA();
	stopB();
});

test("schedules the next poll after the previous one completes", async () => {
	const poller = new Poller();
	const poll = jest.fn(() => new Promise((resolve) => setTimeout(() => resolve("v"), 300)));
	const stop = poller.subscribe("k", { poll, intervalMs: 1000 }, subscriber());
	await jest.advanceTimersByTimeAsync(300);
	expect(poll).toHaveBeenCalledTimes(1);
	await jest.advanceTimersByTimeAsync(999);
	expect(poll).toHaveBeenCalledTimes(1);
	await jest.advanceTimersByTimeAsync(1);
	expect(poll).toHaveBeenCalledTimes(2);
	stop();
});

test("different keys poll independently", async () => {
	const poller = new Poller();
	const pollA = jest.fn(async () => "a");
	const pollB = jest.fn(async () => "b");
	const stopA = poller.subscribe("a", { poll: pollA, intervalMs: 1000 }, subscriber());
	const stopB = poller.subscribe("b", { poll: pollB, intervalMs: 1000 }, subscriber());
	await jest.advanceTimersByTimeAsync(0);
	expect(pollA).toHaveBeenCalledTimes(1);
	expect(pollB).toHaveBeenCalledTimes(1);
	stopA();
	stopB();
});

test("errors reach onError and polling continues", async () => {
	const poller = new Poller();
	let fail = true;
	const poll = jest.fn(async () => {
		if (fail) throw new Error("down");
		return "up";
	});
	const s = subscriber();
	const stop = poller.subscribe("k", { poll, intervalMs: 1000 }, s);
	await jest.advanceTimersByTimeAsync(0);
	expect(s.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "down" }));
	fail = false;
	await jest.advanceTimersByTimeAsync(1000);
	expect(s.onResult).toHaveBeenCalledWith("up");
	stop();
});

test("a late subscriber receives the latest outcome without waiting", async () => {
	const poller = new Poller();
	const poll = jest.fn(async () => "v");
	const stopFirst = poller.subscribe("k", { poll, intervalMs: 1000 }, subscriber());
	await jest.advanceTimersByTimeAsync(0);
	const late = subscriber();
	const stopLate = poller.subscribe("k", { poll, intervalMs: 1000 }, late);
	await jest.advanceTimersByTimeAsync(0);
	expect(late.onResult).toHaveBeenCalledWith("v");
	expect(poll).toHaveBeenCalledTimes(1);
	stopFirst();
	stopLate();
});

test("uses the shortest interval among subscribers", async () => {
	const poller = new Poller();
	const poll = jest.fn(async () => "v");
	const stopSlow = poller.subscribe("k", { poll, intervalMs: 5000 }, subscriber());
	const stopFast = poller.subscribe("k", { poll, intervalMs: 1000 }, subscriber());
	await jest.advanceTimersByTimeAsync(1000);
	expect(poll).toHaveBeenCalledTimes(2);
	stopSlow();
	stopFast();
});

test("stops polling once the last subscriber leaves", async () => {
	const poller = new Poller();
	const poll = jest.fn(async () => "v");
	const stopA = poller.subscribe("k", { poll, intervalMs: 1000 }, subscriber());
	const stopB = poller.subscribe("k", { poll, intervalMs: 1000 }, subscriber());
	await jest.advanceTimersByTimeAsync(0);
	stopA();
	await jest.advanceTimersByTimeAsync(1000);
	expect(poll).toHaveBeenCalledTimes(2);
	stopB();
	await jest.advanceTimersByTimeAsync(5000);
	expect(poll).toHaveBeenCalledTimes(2);
	expect(poller.entries.size).toBe(0);
});

test("an unsubscribed subscriber is no longer called", async () => {
	const poller = new Poller();
	const poll = jest.fn(async () => "v");
	const gone = subscriber();
	const kept = subscriber();
	const stopGone = poller.subscribe("k", { poll, intervalMs: 1000 }, gone);
	const stopKept = poller.subscribe("k", { poll, intervalMs: 1000 }, kept);
	stopGone();
	await jest.advanceTimersByTimeAsync(0);
	expect(gone.onResult).not.toHaveBeenCalled();
	expect(kept.onResult).toHaveBeenCalled();
	stopKept();
});

test("a throwing subscriber does not affect the others", async () => {
	const log = jest.fn();
	const poller = new Poller({ log });
	const bad = {
		onResult: () => {
			throw new Error("oops");
		},
		onError: jest.fn(),
	};
	const good = subscriber();
	const stopBad = poller.subscribe("k", { poll: async () => "v", intervalMs: 1000 }, bad);
	const stopGood = poller.subscribe("k", { poll: async () => "v", intervalMs: 1000 }, good);
	await jest.advanceTimersByTimeAsync(0);
	expect(good.onResult).toHaveBeenCalledWith("v");
	expect(log).toHaveBeenCalledWith(expect.stringContaining("oops"));
	stopBad();
	stopGood();
});

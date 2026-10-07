const http = require("http");
const HttpClient = require("../src/http/client.js");
const { buildAuthorization } = require("../src/http/auth.js");

// Fake fetch recording calls; `handler(url, init)` returns { status, body } or throws
function fakeFetch(handler = () => ({ status: 200, body: "ok" })) {
	const fn = jest.fn(async (url, init) => {
		const r = await handler(url, init);
		return { status: r.status, text: async () => r.body };
	});
	return fn;
}

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("buildAuthorization", () => {
	test.each`
		auth                                   | expected
		${{}}                                  | ${undefined}
		${{ username: "", password: "" }}      | ${undefined}
		${{ bearerToken: "t" }}                | ${"Bearer t"}
		${{ username: "u", password: "p" }}    | ${"Basic " + Buffer.from("u:p").toString("base64")}
		${{ bearerToken: "t", username: "u" }} | ${"Bearer t"}
	`("$auth -> $expected", ({ auth, expected }) => {
		expect(buildAuthorization(auth)).toBe(expected);
	});
});

describe("requests", () => {
	test("returns status and body; HTTP error statuses are not errors", async () => {
		const fetch = fakeFetch(() => ({ status: 500, body: "boom" }));
		const client = new HttpClient({ fetch });
		expect(await client.read({ url: "http://h/a" })).toEqual({ status: 500, body: "boom" });
	});

	test("sends Bearer, Basic, or no Authorization header", async () => {
		const fetch = fakeFetch();
		await new HttpClient({ fetch, auth: { bearerToken: "t", username: "u", password: "p" } }).read({
			url: "http://h/1",
		});
		await new HttpClient({ fetch, auth: { username: "u", password: "p" } }).read({ url: "http://h/2" });
		await new HttpClient({ fetch }).read({ url: "http://h/3" });
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
		expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
		expect(fetch.mock.calls[2][1].headers).toEqual({});
	});

	test("POST sends the body without a Content-Type; GET never sends a body", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch });
		await client.write({ url: "http://h/p", method: "post", body: "a=1" });
		await client.read({ url: "http://h/g", body: "ignored" });
		const [, post] = fetch.mock.calls[0];
		expect(post.method).toBe("POST");
		expect(Buffer.from(post.body).toString()).toBe("a=1");
		expect(post.headers["Content-Type"]).toBeUndefined();
		expect(fetch.mock.calls[1][1].body).toBeUndefined();
	});

	describe("immediately: false", () => {
		test("retries with Basic credentials after a 401", async () => {
			const fetch = fakeFetch((url, init) =>
				init.headers.Authorization ? { status: 200, body: "ok" } : { status: 401, body: "" }
			);
			const client = new HttpClient({ fetch, auth: { username: "u", password: "p", immediately: false } });
			expect(await client.read({ url: "http://h/a" })).toEqual({ status: 200, body: "ok" });
			expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
			expect(fetch.mock.calls[1][1].headers.Authorization).toMatch(/^Basic /);
		});

		test("does not apply to Bearer tokens", async () => {
			const fetch = fakeFetch();
			const client = new HttpClient({ fetch, auth: { bearerToken: "t", immediately: false } });
			await client.read({ url: "http://h/a" });
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
		});
	});
});

describe("sharing identical in-flight reads", () => {
	test("one request serves concurrent identical reads", async () => {
		const gate = deferred();
		const fetch = fakeFetch(async () => {
			await gate.promise;
			return { status: 200, body: "shared" };
		});
		const client = new HttpClient({ fetch });
		const a = client.read({ url: "http://h/a" });
		const b = client.read({ url: "http://h/a" });
		gate.resolve();
		expect(await a).toEqual(await b);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("different url, method or body are separate requests", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch });
		await Promise.all([
			client.read({ url: "http://h/a" }),
			client.read({ url: "http://h/b" }),
			client.read({ url: "http://h/a", method: "POST", body: "1" }),
			client.read({ url: "http://h/a", method: "POST", body: "2" }),
		]);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	test("writes are never shared", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch });
		await Promise.all([client.write({ url: "http://h/s" }), client.write({ url: "http://h/s" })]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("a failed shared read rejects every waiter and is not remembered", async () => {
		let fail = true;
		const fetch = fakeFetch(() => {
			if (fail) throw new Error("down");
			return { status: 200, body: "up" };
		});
		const client = new HttpClient({ fetch, cacheTTL: 60 });
		const results = await Promise.allSettled([client.read({ url: "http://h/a" }), client.read({ url: "http://h/a" })]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		fail = false;
		expect((await client.read({ url: "http://h/a" })).body).toBe("up");
	});
});

describe("cache", () => {
	function clocked(options) {
		let time = 1000;
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch, now: () => time, ...options });
		return { client, fetch, advance: (ms) => (time += ms) };
	}

	test("serves a response until cacheTTL expires", async () => {
		const { client, fetch, advance } = clocked({ cacheTTL: 5 });
		await client.read({ url: "http://h/a" });
		advance(4999);
		await client.read({ url: "http://h/a" });
		expect(fetch).toHaveBeenCalledTimes(1);
		advance(1);
		await client.read({ url: "http://h/a" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("is disabled when cacheTTL is 0", async () => {
		const { client, fetch } = clocked({ cacheTTL: 0 });
		await client.read({ url: "http://h/a" });
		await client.read({ url: "http://h/a" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("fresh skips the lookup but refreshes the entry", async () => {
		let n = 0;
		const fetch = fakeFetch(() => ({ status: 200, body: String(++n) }));
		const client = new HttpClient({ fetch, cacheTTL: 60 });
		expect((await client.read({ url: "http://h/a" })).body).toBe("1");
		expect((await client.read({ url: "http://h/a" }, { fresh: true })).body).toBe("2");
		expect((await client.read({ url: "http://h/a" })).body).toBe("2");
	});

	test("a successful write clears the cache", async () => {
		const { client, fetch } = clocked({ cacheTTL: 60 });
		await client.read({ url: "http://h/a" });
		await client.write({ url: "http://h/set" });
		await client.read({ url: "http://h/a" });
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	test("a failed write keeps the cache", async () => {
		let failWrite = false;
		const fetch = fakeFetch((url) => {
			if (failWrite && url.includes("/set")) throw new Error("down");
			return { status: 200, body: "ok" };
		});
		const client = new HttpClient({ fetch, cacheTTL: 60 });
		await client.read({ url: "http://h/a" });
		failWrite = true;
		await expect(client.write({ url: "http://h/set" })).rejects.toThrow("down");
		await client.read({ url: "http://h/a" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("a read that was in flight during a write is not cached", async () => {
		const gate = deferred();
		let first = true;
		const fetch = fakeFetch(async (url) => {
			if (url.endsWith("/a") && first) {
				first = false;
				await gate.promise;
				return { status: 200, body: "stale" };
			}
			return { status: 200, body: "fresh" };
		});
		const client = new HttpClient({ fetch, cacheTTL: 60 });
		const read = client.read({ url: "http://h/a" });
		await client.write({ url: "http://h/set" });
		gate.resolve();
		await read;
		expect((await client.read({ url: "http://h/a" })).body).toBe("fresh");
	});

	test("request keys differ per credentials", () => {
		const key = (auth) => new HttpClient({ auth }).keyFor({ url: "http://h/a" });
		expect(key({ bearerToken: "a" })).not.toBe(key({ bearerToken: "b" }));
		expect(key({ username: "u", password: "1" })).not.toBe(key({ username: "u", password: "2" }));
	});
});

describe("timeout and retries", () => {
	// Rejects when the request signal aborts, like real fetch
	const hanging = () =>
		jest.fn(
			(url, init) =>
				new Promise((resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason));
				})
		);

	test("times out with a message that does not include the url", async () => {
		const client = new HttpClient({ fetch: hanging(), timeout: 20 });
		await expect(client.read({ url: "http://h/secret?token=abc" })).rejects.toThrow("Request timed out after 20ms");
		await client.read({ url: "http://h/secret?token=abc" }).catch((e) => expect(e.message).not.toMatch(/abc/));
	});

	test("timeout 0 disables the signal", async () => {
		const fetch = fakeFetch();
		await new HttpClient({ fetch, timeout: 0 }).read({ url: "http://h/a" });
		expect(fetch.mock.calls[0][1].signal).toBeUndefined();
	});

	test("retries reads after network errors", async () => {
		let calls = 0;
		const fetch = fakeFetch(() => {
			if (++calls < 3) throw new Error("reset");
			return { status: 200, body: "ok" };
		});
		const client = new HttpClient({ fetch, retries: 2, retryDelay: 1 });
		expect((await client.read({ url: "http://h/a" })).body).toBe("ok");
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	test("gives up after the configured retries", async () => {
		const fetch = fakeFetch(() => {
			throw new Error("reset");
		});
		const client = new HttpClient({ fetch, retries: 1, retryDelay: 1 });
		await expect(client.read({ url: "http://h/a" })).rejects.toThrow("reset");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("does not retry writes", async () => {
		const fetch = fakeFetch(() => {
			throw new Error("reset");
		});
		const client = new HttpClient({ fetch, retries: 3, retryDelay: 1 });
		await expect(client.write({ url: "http://h/s" })).rejects.toThrow("reset");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("uses the underlying cause as the error message", async () => {
		const fetch = jest.fn(async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 10.0.0.1:80") });
		});
		await expect(new HttpClient({ fetch }).read({ url: "http://h/a" })).rejects.toThrow("connect ECONNREFUSED");
	});
});

describe("request limiting", () => {
	test("maxConcurrent caps simultaneous requests", async () => {
		let active = 0;
		let peak = 0;
		const fetch = fakeFetch(async () => {
			peak = Math.max(peak, ++active);
			await new Promise((r) => setTimeout(r, 15));
			active--;
			return { status: 200, body: "ok" };
		});
		const client = new HttpClient({ fetch, maxConcurrent: 2 });
		await Promise.all([1, 2, 3, 4, 5].map((i) => client.read({ url: "http://h/" + i })));
		expect(peak).toBe(2);
	});
});

describe("per-request bearer token override", () => {
	test("replaces the client token for one request", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch, auth: { bearerToken: "client" } });
		await client.read({ url: "http://h/a" }, { auth: { bearerToken: "action" } });
		await client.read({ url: "http://h/b" });
		await client.write({ url: "http://h/c" }, { auth: { bearerToken: "write" } });
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer action");
		expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer client");
		expect(fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer write");
	});

	test("an empty override turns the token off and falls back to Basic credentials", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch, auth: { bearerToken: "client", username: "u", password: "p" } });
		await client.read({ url: "http://h/a" }, { auth: { bearerToken: "" } });
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
	});

	test("requests with different tokens are neither shared nor cached together", async () => {
		const fetch = fakeFetch();
		const client = new HttpClient({ fetch, cacheTTL: 60, auth: { bearerToken: "client" } });
		await Promise.all([
			client.read({ url: "http://h/a" }),
			client.read({ url: "http://h/a" }, { auth: { bearerToken: "other" } }),
		]);
		await client.read({ url: "http://h/a" }, { auth: { bearerToken: "other" } });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(client.keyFor({ url: "http://h/a" })).not.toBe(
			client.keyFor({ url: "http://h/a" }, { bearerToken: "other" })
		);
	});
});

describe("redirects (real servers)", () => {
	let target, origin, targetSeen, originUrl, targetUrl;

	const listen = (handler) =>
		new Promise((resolve) => {
			const server = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(server));
		});

	beforeAll(async () => {
		target = await listen((req, res) => {
			targetSeen = req.headers.authorization;
			res.end("target");
		});
		targetUrl = "http://127.0.0.1:" + target.address().port + "/final";
		origin = await listen((req, res) => {
			res.writeHead(302, { Location: targetUrl });
			res.end();
		});
		originUrl = "http://127.0.0.1:" + origin.address().port + "/start";
	});

	afterAll(async () => {
		// fetch keeps connections alive, which would hold close() open
		for (const server of [target, origin]) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	test("does not forward Authorization to a different origin", async () => {
		targetSeen = undefined;
		const client = new HttpClient({ auth: { bearerToken: "secret" } });
		const res = await client.read({ url: originUrl });
		expect(res.body).toBe("target");
		expect(targetSeen).toBeUndefined();
	});
});

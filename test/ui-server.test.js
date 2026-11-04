const { fork } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Starts homebridge-ui/server.js the way the Homebridge UI does (a child process with a message channel) and speaks
// its protocol, with a real HTTP server standing in for the device.

const serverPath = path.join(__dirname, "..", "homebridge-ui", "server.js");

const children = [];
const directories = [];
const servers = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function configFile(config) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ui-server-"));
	directories.push(directory);
	const file = path.join(directory, "config.json");
	fs.writeFileSync(file, JSON.stringify(config));
	return file;
}

async function startServer(config = { platforms: [] }) {
	const child = fork(serverPath, [], {
		env: { ...process.env, HOMEBRIDGE_CONFIG_PATH: configFile(config) },
		silent: true,
	});
	children.push(child);

	const waiting = new Map();
	let ready;
	const isReady = new Promise((resolve) => (ready = resolve));
	child.on("message", (message) => {
		if (message.action === "ready") ready(message);
		if (message.action === "response") waiting.get(message.payload.requestId)(message.payload);
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

	let counter = 0;
	const request = (route, body) =>
		new Promise((resolve) => {
			const requestId = `r${++counter}`;
			waiting.set(requestId, resolve);
			child.send({ action: "request", requestId, path: route, body });
		});

	const first = await Promise.race([isReady, exited.then((code) => `exited with ${code}`)]);
	expect(first).toMatchObject({ action: "ready", payload: { server: true } });
	return { request, child };
}

async function device(handler) {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${server.address().port}`;
}

const sensor = (url) => ({
	name: "Air",
	service: "CarbonDioxideSensor",
	bearerToken: "secret-token",
	characteristics: [
		{
			characteristic: "CarbonDioxideLevel",
			get: { url, mappers: [{ type: "jpath", jpath: "$.co2" }, { type: "number" }] },
		},
	],
});

describe("homebridge-ui/server.js", () => {
	test("starts and tells the Homebridge UI that it is ready", async () => {
		const { request } = await startServer();
		expect(await request("/info")).toEqual({ requestId: "r1", success: true, data: { testsDisabled: false } });
	});

	test("checks a configuration", async () => {
		const { request } = await startServer();
		const response = await request("/validate", {
			config: [{ platform: "HttpAdvancedPlatform", devices: [{ name: "No service" }] }],
		});
		expect(response.success).toBe(true);
		expect(response.data.devices[0].errors.join()).toMatch(/service/);
	});

	test("tests a read against a real device, with the authentication of the device", async () => {
		const seen = [];
		const url = await device((req, res) => {
			seen.push(req.headers.authorization);
			res.setHeader("Content-Type", "application/json");
			res.end('{"co2": "745"}');
		});
		const { request } = await startServer();

		const response = await request("/test-get", { device: sensor(url), characteristic: "CarbonDioxideLevel" });
		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({ ok: true, status: 200, value: "745" });
		expect(seen).toEqual(["Bearer secret-token"]);
		expect(JSON.stringify(response)).not.toContain("secret-token");
	});

	test("does not send test requests when the Homebridge UI has no login", async () => {
		const seen = [];
		const url = await device((req, res) => {
			seen.push(req.url);
			res.end("{}");
		});
		const { request } = await startServer({ platforms: [{ platform: "config", auth: "none" }] });

		expect(await request("/info")).toMatchObject({ data: { testsDisabled: true } });
		const response = await request("/test-get", { device: sensor(url), characteristic: "CarbonDioxideLevel" });
		expect(response.data).toMatchObject({ ok: false, disabled: true });
		expect(seen).toEqual([]);
	});

	test("answers every request the page makes", async () => {
		const { request } = await startServer();
		const device = sensor("http://127.0.0.1:1/");
		device.characteristics[0].set = { url: "http://127.0.0.1:1/set?v={value}" };

		for (const [route, body, expected] of [
			["/preview-set", { device, characteristic: "CarbonDioxideLevel", value: "5" }, { ok: true }],
			["/import-1x", { config: "{oops" }, { ok: false }],
			["/cached", { config: [], cached: [] }, { accessories: [], pending: [] }],
			["/device-schema", undefined, { layout: null, form: null }],
			["/defaults-schema", undefined, { layout: null, form: null }],
		]) {
			const response = await request(route, body);
			expect({ route, success: response.success }).toEqual({ route, success: true });
			expect(response.data).toMatchObject(expected);
		}
	});

	test("refuses a route it does not have", async () => {
		const { request } = await startServer();
		expect(await request("/nope")).toMatchObject({ success: false, data: { message: "Not Found" } });
	});

	test("stops when the Homebridge UI closes the connection", async () => {
		const { child } = await startServer();
		const exited = new Promise((resolve) => child.on("exit", resolve));
		child.disconnect();
		// SIGTERM on Linux and macOS; Windows has no signals and reports exit code 1
		await exited;
		expect(child.exitCode === 1 || child.signalCode === "SIGTERM").toBe(true);
	});
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const script = path.join(__dirname, "..", "scripts", "migrate-config.js");
let dir;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "hhaa-migrate-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const write = (name, content) => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return file;
};
const input = JSON.stringify({
	accessories: [
		{
			accessory: "HttpAdvancedAccessory",
			name: "A",
			service: "Switch",
			uriCallsDelay: 10,
			urls: { getOn: { url: "u" } },
		},
	],
});

test("prints the migrated config to stdout and the warnings to stderr", () => {
	const result = run(write("config.json", input));
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout).platforms[0].devices[0].name).toBe("A");
	expect(result.stderr).toMatch("uriCallsDelay");
	expect(result.stderr).toMatch("Migrated 1 accessory with 1 warning");
});

test("writes to the output file and never touches the input", () => {
	const source = write("config.json", input);
	const output = path.join(dir, "migrated.json");
	expect(run(source, output).status).toBe(0);
	expect(JSON.parse(fs.readFileSync(output, "utf8")).platforms).toHaveLength(1);
	expect(fs.readFileSync(source, "utf8")).toBe(input);
});

test("refuses to overwrite the input", () => {
	const source = write("config.json", input);
	const result = run(source, source);
	expect(result.status).toBe(1);
	expect(fs.readFileSync(source, "utf8")).toBe(input);
});

test("fails on a missing or invalid file", () => {
	expect(run(path.join(dir, "missing.json")).status).toBe(1);
	expect(run(write("bad.json", "{")).status).toBe(1);
});

test("prints usage without arguments", () => {
	const result = run();
	expect(result.status).toBe(1);
	expect(result.stderr).toMatch("Usage");
});

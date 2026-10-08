const fs = require("fs");
const os = require("os");
const path = require("path");
const { mergeHeaders, resolveHeaders } = require("../src/http/headers.js");

describe("mergeHeaders", () => {
	test("puts the lists after each other and lets a later name replace an earlier one without regard to case", () => {
		const merged = mergeHeaders(
			[
				{ name: "X-Api-Key", value: "platform" },
				{ name: "Accept", value: "text/plain" },
			],
			[{ name: "x-api-key", value: "device" }]
		);
		expect(merged).toEqual([
			{ name: "Accept", value: "text/plain" },
			{ name: "x-api-key", value: "device" },
		]);
	});

	test("ignores missing lists and the empty row of the form", () => {
		expect(mergeHeaders(undefined, [{}, { name: "", value: "" }], null)).toEqual([]);
	});
});

describe("resolveHeaders", () => {
	const ENV = "HHAA_HEADER_TEST";
	afterEach(() => delete process.env[ENV]);

	test("builds an object from literal values", () => {
		const { headers, error } = resolveHeaders(
			[
				{ name: "X-Api-Key", value: " abc " },
				{ name: "Content-Type", value: "application/json" },
			],
			"Device"
		);
		expect(headers).toEqual({ "X-Api-Key": "abc", "Content-Type": "application/json" });
		expect(error).toBeNull();
	});

	test("reads a value from an environment variable or a file", () => {
		process.env[ENV] = "from-env";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hhaa-headers-"));
		const file = path.join(dir, "key");
		fs.writeFileSync(file, "from-file\n");
		try {
			const { headers } = resolveHeaders(
				[
					{ name: "A", value: "env:" + ENV },
					{ name: "B", value: "file:" + file },
				],
				"Device"
			);
			expect(headers).toEqual({ A: "from-env", B: "from-file" });
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test("an unavailable source is reported as an error that names the header and not its value", () => {
		const { headers, error } = resolveHeaders([{ name: "X-Api-Key", value: "env:" + ENV }], "Device");
		expect(headers).toEqual({});
		expect(error.message).toBe(`header "X-Api-Key": environment variable "${ENV}" is not set or empty`);
	});

	test("an empty value is kept, as some servers expect a header without a value", () => {
		expect(resolveHeaders([{ name: "X-Empty", value: "" }], "Device").headers).toEqual({ "X-Empty": "" });
		expect(resolveHeaders([{ name: "X-Empty" }], "Device").headers).toEqual({ "X-Empty": "" });
	});

	test.each([["a b"], ["a:b"], ["a\nb"], ["é"], [""]])("rejects the header name %j", (name) => {
		expect(() => resolveHeaders([{ name, value: "x" }], 'Device "Lamp"')).toThrow(
			/^Device "Lamp": a header needs a name/
		);
	});

	test("rejects a value with a line break and a value that is not text", () => {
		expect(() => resolveHeaders([{ name: "A", value: "x\r\nInjected: 1" }], "Device")).toThrow("contains a line break");
		expect(() => resolveHeaders([{ name: "A", value: { x: 1 } }], "Device")).toThrow("must be text");
	});
});

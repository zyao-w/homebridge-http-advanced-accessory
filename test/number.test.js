const mappers = require("../src/mappers/index.js");
const { normalizeDevice } = require("../src/device-config.js");
const { validateDevice } = require("../src/validate.js");

const number = (parameters = {}) => new mappers.NumberMapper(parameters);

describe("NumberMapper", () => {
	test.each`
		input       | expected
		${612}      | ${612}
		${-4.5}     | ${-4.5}
		${0}        | ${0}
		${"612"}    | ${612}
		${" 12.5 "} | ${12.5}
		${"-0.25"}  | ${-0.25}
		${"1e3"}    | ${1000}
	`("converts $input to $expected", ({ input, expected }) => {
		expect(number().map(input)).toBe(expected);
	});

	test.each([undefined, null, "", "  ", "abc", "12px", "4.5 C", "[]", "inconclusive", NaN, Infinity, true, {}, []])(
		"returns inconclusive for %p",
		(input) => {
			expect(number().map(input)).toBe("inconclusive");
		}
	);

	test("rounds to the given number of decimal places", () => {
		expect(number({ round: 0 }).map("23.6")).toBe(24);
		expect(number({ round: 1 }).map(23.46)).toBe(23.5);
		expect(number({ round: "2" }).map(1.005 + 0.0001)).toBe(1.01);
		expect(Object.is(number({ round: 0 }).map(-0.2), 0)).toBe(true);
	});

	test("does not round without the setting", () => {
		expect(number().map("23.4567")).toBe(23.4567);
		expect(number({ round: null }).map(1.234)).toBe(1.234);
	});

	test.each([-1, 11, 1.5, "x"])("refuses a round of %p", (round) => {
		expect(() => number({ round })).toThrow(/"round" of a "number" mapper/);
	});
});

describe("a number mapper in a device", () => {
	const device = (mappersList) => ({
		name: "Air",
		service: "CarbonDioxideSensor",
		characteristics: [{ characteristic: "CarbonDioxideLevel", get: { url: "http://h/air", mappers: mappersList } }],
	});
	const run = (normalized, input) => normalized.characteristics[0].get.mappers.reduce((v, m) => m.map(v), input);

	test("validates and loads, and a missing value stays inconclusive through the chain", () => {
		const entry = device([
			{ type: "jpath", jpath: "$.data.co2" },
			{ type: "number", round: 0 },
		]);
		expect(validateDevice(entry).errors).toEqual([]);
		const normalized = normalizeDevice(entry);
		expect(run(normalized, '{"data":{"co2":612.4}}')).toBe(612);
		expect(run(normalized, '{"data":{"co2":"abc"}}')).toBe("inconclusive");
		expect(run(normalized, '{"data":{}}')).toBe("inconclusive");
		expect(run(normalized, "<html>")).toBe("inconclusive");
	});

	test("reports a wrong round with the characteristic it belongs to", () => {
		expect(() => normalizeDevice(device([{ type: "number", round: 11 }]))).toThrow(
			/Device "Air" CarbonDioxideLevel get: "round" of a "number" mapper/
		);
		expect(validateDevice(device([{ type: "number", round: 11 }])).errors).toEqual([
			expect.stringMatching(/round must be <= 10/),
		]);
	});
});

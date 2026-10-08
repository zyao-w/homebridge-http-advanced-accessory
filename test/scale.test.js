const mappers = require("../src/mappers/index.js");
const { normalizeDevice } = require("../src/device-config.js");
const { validateDevice } = require("../src/validate.js");

const scale = (parameters) => new mappers.ScaleMapper(parameters);
const dimmer = { inputMin: 0, inputMax: 255, outputMin: 0, outputMax: 100 };

describe("ScaleMapper", () => {
	test.each`
		input     | expected
		${0}      | ${0}
		${255}    | ${100}
		${127.5}  | ${50}
		${"51"}   | ${20}
		${" 51 "} | ${20}
	`("converts $input to $expected", ({ input, expected }) => {
		expect(scale(dimmer).map(input)).toBe(expected);
	});

	test("rounds to the given number of decimal places", () => {
		expect(scale({ ...dimmer, round: 0 }).map(128)).toBe(50);
		expect(scale({ ...dimmer, round: 1 }).map(128)).toBe(50.2);
		expect(scale({ ...dimmer, round: 2 }).map(128)).toBe(50.2);
		expect(scale({ ...dimmer, round: "0" }).map(128)).toBe(50);
		expect(scale({ ...dimmer }).map(128)).toBeCloseTo(50.196, 3);
	});

	test("extrapolates outside the input range unless clamp is set", () => {
		expect(scale(dimmer).map(510)).toBe(200);
		expect(scale({ ...dimmer, clamp: true }).map(510)).toBe(100);
		expect(scale({ ...dimmer, clamp: true }).map(-5)).toBe(0);
	});

	test("handles inverted and negative ranges", () => {
		const inverted = { inputMin: 0, inputMax: 100, outputMin: 100, outputMax: 0 };
		expect(scale(inverted).map(25)).toBe(75);
		expect(scale({ ...inverted, clamp: true }).map(120)).toBe(0);

		const reversedInput = { inputMin: 100, inputMax: 0, outputMin: 0, outputMax: 10 };
		expect(scale({ ...reversedInput, clamp: true }).map(150)).toBe(0);

		const celsius = { inputMin: -40, inputMax: 60, outputMin: -40, outputMax: 140 };
		expect(scale(celsius).map(20)).toBe(68);
	});

	test("never returns negative zero", () => {
		expect(Object.is(scale({ ...dimmer, outputMin: -1, outputMax: 1, round: 0 }).map(127.4), 0)).toBe(true);
	});

	test.each([undefined, null, "", "  ", "abc", "12px", NaN, Infinity, true, {}, []])(
		"returns inconclusive for %p",
		(input) => {
			expect(scale(dimmer).map(input)).toBe("inconclusive");
		}
	);

	test.each([
		[{ ...dimmer, inputMin: undefined }, /"inputMin"/],
		[{ ...dimmer, outputMax: "x" }, /"outputMax"/],
		[{ ...dimmer, inputMax: 0 }, /differs from "inputMax"/],
		[{ ...dimmer, round: -1 }, /"round"/],
		[{ ...dimmer, round: 1.5 }, /"round"/],
		[{ ...dimmer, round: 11 }, /"round"/],
	])("refuses the settings %j", (parameters, message) => {
		expect(() => scale(parameters)).toThrow(message);
	});
});

describe("a scale mapper in a device", () => {
	const device = (mapper, extra = {}) => ({
		name: "Dimmer",
		service: "Lightbulb",
		characteristics: [{ characteristic: "Brightness", get: { url: "http://h/level", mappers: [mapper] }, ...extra }],
	});
	const chainOf = (normalized) => normalized.characteristics[0].get.mappers;

	test("validates and loads", () => {
		const entry = device({ type: "scale", ...dimmer, round: 0, clamp: true });
		expect(validateDevice(entry).errors).toEqual([]);
		expect(chainOf(normalizeDevice(entry))[0].map("255")).toBe(100);
	});

	test("accepts negative numbers in the form schema", () => {
		const entry = device({ type: "scale", inputMin: -40, inputMax: 60, outputMin: -10, outputMax: 10 });
		expect(validateDevice(entry).errors).toEqual([]);
	});

	test("reports wrong settings with the characteristic they belong to", () => {
		expect(() => normalizeDevice(device({ type: "scale", ...dimmer, inputMax: 0 }))).toThrow(
			/Brightness get: a "scale" mapper needs an "inputMin" that differs/
		);
		expect(validateDevice(device({ type: "scale", ...dimmer, round: 11 })).errors).toEqual([
			expect.stringMatching(/round must be <= 10/),
		]);
	});
});

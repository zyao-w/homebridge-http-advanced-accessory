const { suggestPaths } = require("../src/suggest.js");
const { createMapper } = require("../src/mappers/index.js");

// Every suggestion must select the value it shows, with the mapper that the plugin uses at runtime
function expectSelect(body, suggestions) {
	for (const { type, path, sample } of suggestions) {
		const mapper = createMapper(type, type === "jpath" ? { jpath: path } : { xpath: path });
		expect({ path, value: String(mapper.map(body)).slice(0, 80) }).toEqual({ path, value: sample });
	}
}

describe("suggestPaths", () => {
	test("lists the values of a JSON response, with the path that selects each", () => {
		const body = JSON.stringify({ data: { co2: 812, ok: true, name: "Air", list: [1, 2] }, empty: null });
		const { format, suggestions } = suggestPaths(body);

		expect(format).toBe("json");
		expect(suggestions.map((s) => [s.path, s.sample])).toEqual([
			["$.data.co2", "812"],
			["$.data.ok", "true"],
			["$.data.name", "Air"],
			["$.data.list[0]", "1"],
			["$.data.list[1]", "2"],
		]);
		expectSelect(body, suggestions);
	});

	test("writes keys that are not identifiers in brackets", () => {
		const body = JSON.stringify({ "a-b": { "it's": 1 }, "1st": 2 });
		const { suggestions } = suggestPaths(body);
		expect(suggestions.map((s) => s.path)).toEqual(["$['a-b']['it\\'s']", "$['1st']"]);
		expectSelect(body, suggestions);
	});

	test("handles a JSON list at the top", () => {
		const body = JSON.stringify([{ t: 20 }, { t: 21 }]);
		const { suggestions } = suggestPaths(body);
		expect(suggestions.map((s) => s.path)).toEqual(["$[0].t", "$[1].t"]);
		expectSelect(body, suggestions);
	});

	test("lists the text of an XML response, with a position only where elements repeat", () => {
		const body =
			"<partitionsStatus><partition>ARMED</partition><partition>DISARMED</partition><info><temp>21.5</temp></info></partitionsStatus>";
		const { format, suggestions } = suggestPaths(body);

		expect(format).toBe("xml");
		expect(suggestions.map((s) => [s.path, s.sample])).toEqual([
			["/partitionsStatus/partition[1]/text()", "ARMED"],
			["/partitionsStatus/partition[2]/text()", "DISARMED"],
			["/partitionsStatus/info/temp/text()", "21.5"],
		]);
		expectSelect(body, suggestions);
	});

	test("skips XML elements without text of their own", () => {
		const { suggestions } = suggestPaths("<a><b/><c>  </c><d>x<e>y</e></d></a>");
		expect(suggestions.map((s) => s.path)).toEqual(["/a/d/e/text()"]);
	});

	test("has nothing to suggest for plain text, empty or broken input", () => {
		expect(suggestPaths("temperature=21")).toEqual({ format: "text", suggestions: [] });
		expect(suggestPaths("")).toEqual({ format: "text", suggestions: [] });
		expect(suggestPaths(undefined)).toEqual({ format: "text", suggestions: [] });
		expect(suggestPaths("{not json").format).toBe("text");
		expect(suggestPaths("<a><b></a>").suggestions).toEqual(expect.any(Array));
	});

	test("cuts a long sample and limits how many it lists", () => {
		const long = suggestPaths(JSON.stringify({ text: "x".repeat(500) }));
		expect(long.suggestions[0].sample).toHaveLength(80);

		const many = suggestPaths(JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]))));
		expect(many.suggestions).toHaveLength(60);
	});

	test("does not follow nesting without end", () => {
		let deep = { value: 1 };
		for (let i = 0; i < 50; i++) deep = { next: deep };
		expect(suggestPaths(JSON.stringify(deep)).suggestions).toEqual([]);
	});
});

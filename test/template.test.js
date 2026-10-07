const { renderTemplate } = require("../src/template.js");

test("replaces {value} with the mapped value, case-insensitively", () => {
	expect(renderTemplate("http://h/set?a={value}&b={VALUE}", { mappedValue: "on" })).toBe("http://h/set?a=on&b=on");
});

test("evaluates ${...} expressions with value and state in scope", () => {
	const out = renderTemplate("http://h/set?x=${value == 1 ? 'a' : 'b'}&t=${state.getTarget * 9 / 5 + 32}", {
		value: 1,
		state: { getTarget: 20 },
		mappedValue: "ignored",
	});
	expect(out).toBe("http://h/set?x=a&t=68");
});

test("converts a numeric mapped value to text", () => {
	expect(renderTemplate("v={value}", { mappedValue: 0 })).toBe("v=0");
});

test("leaves templates without placeholders untouched", () => {
	expect(renderTemplate("http://h/status", { mappedValue: "x" })).toBe("http://h/status");
});

test("throws on an expression the language does not offer", () => {
	expect(() => renderTemplate("${missing.prop}", { mappedValue: "x" })).toThrow(/Unknown name "missing"/);
});

test("evaluates full JavaScript only when unsafe", () => {
	expect(() => renderTemplate("${missing.prop}", { mappedValue: "x" }, { unsafe: true })).toThrow(ReferenceError);
});

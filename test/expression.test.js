const { compileExpression, compileTemplate, toNumber } = require("../src/expression.js");

const run = (source, scope = {}) => compileExpression(source)(scope);

describe("expressions", () => {
	test("literals and arithmetic follow JavaScript precedence", () => {
		expect(run("1 + 2 * 3")).toBe(7);
		expect(run("(1 + 2) * 3")).toBe(9);
		expect(run("10 % 4 - -2")).toBe(4);
		expect(run("1.5e1 / 3")).toBe(5);
		expect(run(".5 + 1")).toBe(1.5);
		expect(run("'a' + \"b\" + 1")).toBe("ab1");
		expect(run("'it\\'s'")).toBe("it's");
	});

	test("reads value and state", () => {
		expect(run("value * 2", { value: 21 })).toBe(42);
		expect(run("state.Target + value", { value: 1, state: { Target: 20 } })).toBe(21);
		expect(run('state["Current Temperature"]', { state: { "Current Temperature": 5 } })).toBe(5);
		expect(run("state.Missing", { state: {} })).toBeUndefined();
		expect(run("state.On", {})).toBeUndefined();
	});

	test("compares, combines and branches", () => {
		expect(run('value === "OK" ? 1 : 0', { value: "OK" })).toBe(1);
		expect(run('value === "OK" ? 1 : 0', { value: "NO" })).toBe(0);
		expect(run("value == 1", { value: "1" })).toBe(true);
		expect(run("value !== 1", { value: "1" })).toBe(true);
		expect(run("value != null", { value: 0 })).toBe(true);
		expect(run("1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3")).toBe(true);
		expect(run("!value", { value: 0 })).toBe(true);
		expect(run("value > 10 ? 'high' : value > 5 ? 'mid' : 'low'", { value: 7 })).toBe("mid");
	});

	test("&&, || and ?? short-circuit", () => {
		expect(run("value || 5", { value: 0 })).toBe(5);
		expect(run("value && 5", { value: 0 })).toBe(0);
		expect(run("value ?? 5", { value: 0 })).toBe(0);
		expect(run("value ?? 5", { value: null })).toBe(5);
		expect(run("true || state.a.b.c")).toBe(true);
	});

	test("offers number and string functions and Math", () => {
		expect(run("Math.round(value * 10) / 10", { value: 1.26 })).toBe(1.3);
		expect(run("Math.max(1, value, 3)", { value: 7 })).toBe(7);
		expect(run("Math.floor(Math.PI)")).toBe(3);
		expect(run("parseInt(value, 10)", { value: "42px" })).toBe(42);
		expect(run("parseFloat(value)", { value: "4.5 C" })).toBe(4.5);
		expect(run("Number(value)", { value: "7" })).toBe(7);
		expect(run("String(value) + 'x'", { value: 1 })).toBe("1x");
		expect(run("Boolean(value)", { value: "" })).toBe(false);
		expect(run("isNaN(value)", { value: "abc" })).toBe(true);
		expect(run("toNumber(value, -1)", { value: "abc" })).toBe(-1);
		expect(run("toNumber(value)", { value: "12.5" })).toBe(12.5);
		expect(toNumber(undefined)).toBe(0);
	});

	test("reads properties of strings, arrays and plain objects", () => {
		expect(run("value.length", { value: "abc" })).toBe(3);
		expect(run("value[1]", { value: "abc" })).toBe("b");
		expect(run("value[1]", { value: [4, 5] })).toBe(5);
		expect(run("value.a.b", { value: { a: { b: 9 } } })).toBe(9);
		expect(run("value.a.b", { value: {} })).toBeUndefined();
		expect(run("value.x", { value: null })).toBeUndefined();
	});

	test("cannot reach the prototype chain or call methods", () => {
		expect(run("value.constructor", { value: {} })).toBeUndefined();
		expect(run('value["__proto__"]', { value: {} })).toBeUndefined();
		expect(run("value.toString", { value: 1 })).toBeUndefined();
		expect(run("state.hasOwnProperty", { state: {} })).toBeUndefined();
		expect(() => compileExpression("value.toString()")).toThrow(/Only the built-in functions/);
		expect(() => compileExpression("value.constructor('return 1')()")).toThrow(/Only the built-in functions/);
		expect(() => compileExpression("(1).constructor.constructor('x')")).toThrow();
	});

	test.each([
		["process.exit()", /Unknown name "process"/],
		["require('fs')", /Unknown name "require"/],
		["globalThis", /Unknown name "globalThis"/],
		["this", /Unknown name "this"/],
		["self.state", /Unknown name "self"/],
		["eval('1')", /Unknown name "eval"/],
		["Function('return 1')()", /Unknown name "Function"/],
		["Math.random()", /Math.random is not available/],
		["Math.round", /must be called/],
		["Math", /must be followed/],
		["parseInt", /must be called/],
		["JSON.parse(value)", /Unknown name "JSON"/],
		["new Date()", /Unknown name "new"/],
		["value = 1", /Unexpected/],
		["value; value", /Unexpected/],
		["`x`", /Unexpected/],
		["1 +", /Unexpected end/],
		["(1", /Expected "\)"/],
		["value ? 1", /Expected ":"/],
		["'open", /Unterminated string/],
		["", /Unexpected end/],
		["value?.a", /Unexpected|Expected/],
	])("rejects %s", (source, message) => {
		expect(() => compileExpression(source)).toThrow(message);
	});

	test("reports the position of the problem", () => {
		expect(() => compileExpression("1 + * 2")).toThrow(/Invalid expression "1 \+ \* 2": .* at position 4/);
	});

	test("limits the nesting depth", () => {
		expect(() => compileExpression("(".repeat(200) + "1" + ")".repeat(200))).toThrow(/nested too deeply/);
	});

	test("parses an expression once", () => {
		expect(compileExpression("1 + 1")).toBe(compileExpression("1 + 1"));
	});
});

describe("templates", () => {
	const render = (template, scope, options) => compileTemplate(template, options)(scope);

	test("evaluates ${...} and replaces {value} with the mapped value", () => {
		const out = render("http://h/set?x=${value == 1 ? 'a' : 'b'}&t=${state.Target * 9 / 5 + 32}&v={value}", {
			value: 1,
			state: { Target: 20 },
			mappedValue: "M",
		});
		expect(out).toBe("http://h/set?x=a&t=68&v=M");
	});

	test("{value} is case-insensitive and may appear several times", () => {
		expect(render("{value}-{VALUE}", { mappedValue: 3 })).toBe("3-3");
	});

	test("keeps $& and similar sequences of the mapped value", () => {
		expect(render("v={value}", { mappedValue: "$&" })).toBe("v=$&");
	});

	test("handles a closing brace inside a string of the expression", () => {
		expect(render("${'}' + value}", { value: 1 })).toBe("}1");
	});

	test("keeps text without expressions and a lone $ or braces", () => {
		expect(render("a$b{c}", { mappedValue: 1 })).toBe("a$b{c}");
	});

	test("reports an unterminated or invalid expression", () => {
		expect(() => compileTemplate("http://h/${value")).toThrow(/Invalid template.*Expected "\}"/);
		expect(() => compileTemplate("http://h/${process.exit()}")).toThrow(/Unknown name "process"/);
		expect(() => compileTemplate("http://h/${value.toString()}")).toThrow(/Only the built-in functions/);
	});

	test("full JavaScript is evaluated only when unsafe", () => {
		const template = "u=${[1, 2, 3].map(n => n * value).join('+')}";
		expect(() => compileTemplate(template)).toThrow(/Invalid template/);
		expect(render(template, { value: 2 }, { unsafe: true })).toBe("u=2+4+6");
	});

	test("unsafe templates see value and state", () => {
		expect(
			render("${state.On}-${value}-{value}", { value: 1, state: { On: 0 }, mappedValue: 9 }, { unsafe: true })
		).toBe("0-1-9");
	});
});

/**
 * The restricted expression language of `expression` mappers and `${...}` templates.
 *
 * It is a small subset of JavaScript that is parsed and evaluated here, never passed to `eval`:
 * literals, `value` and `state`, the usual operators, `?:`, a few number and string functions and `Math`.
 * Scope objects are read-only data; nothing reachable from an expression can call anything but the functions below.
 * Anything else belongs in a `script` mapper, which needs `allowUnsafeEval`.
 */

const MAX_DEPTH = 64;

const toNumber = (input, fallback = 0) => {
	const number = parseFloat(input);
	return Number.isFinite(number) ? number : fallback;
};

const FUNCTIONS = {
	parseInt: (input, radix) => parseInt(input, radix),
	parseFloat: (input) => parseFloat(input),
	Number: (input) => Number(input),
	String: (input) => String(input),
	Boolean: (input) => Boolean(input),
	isNaN: (input) => Number.isNaN(Number(input)),
	isFinite: (input) => Number.isFinite(Number(input)),
	toNumber,
};

const MATH_FUNCTIONS = [
	"abs",
	"ceil",
	"floor",
	"round",
	"trunc",
	"sign",
	"min",
	"max",
	"pow",
	"sqrt",
	"log",
	"log10",
	"exp",
];
const MATH_CONSTANTS = ["PI", "E"];

const PUNCTUATORS = [
	"===",
	"!==",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"!",
	"?",
	":",
	"(",
	")",
	"[",
	"]",
	".",
	",",
	"}",
];

const BINARY_LEVELS = [
	["??"],
	["||"],
	["&&"],
	["==", "!=", "===", "!=="],
	["<", ">", "<=", ">="],
	["+", "-"],
	["*", "/", "%"],
];

const ESCAPES = { n: "\n", t: "\t", r: "\r" };

class ExpressionError extends Error {}

function tokenize(source, start) {
	const tokens = [];
	let i = start;

	const fail = (message) => {
		throw new ExpressionError(`${message} at position ${i}`);
	};

	while (i < source.length) {
		const char = source[i];

		if (/\s/.test(char)) {
			i++;
		} else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] || ""))) {
			const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
			tokens.push({ type: "number", value: Number(match[0]), at: i });
			i += match[0].length;
		} else if (/[A-Za-z_$]/.test(char)) {
			const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
			tokens.push({ type: "name", value: match[0], at: i });
			i += match[0].length;
		} else if (char === '"' || char === "'") {
			const at = i++;
			let text = "";
			while (i < source.length && source[i] !== char) {
				if (source[i] === "\\" && i + 1 < source.length) {
					i++;
					text += ESCAPES[source[i]] || source[i];
				} else {
					text += source[i];
				}
				i++;
			}
			if (i >= source.length) {
				i = at;
				fail("Unterminated string");
			}
			i++;
			tokens.push({ type: "string", value: text, at });
		} else {
			const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
			if (!punctuator) {
				fail(`Unexpected "${char}"`);
			}
			tokens.push({ type: "punctuator", value: punctuator, at: i });
			i += punctuator.length;
			if (punctuator === "}") {
				break; // the end of a ${...} template expression
			}
		}
	}

	tokens.push({ type: "end", at: source.length });
	return tokens;
}

class Parser {
	constructor(source, start) {
		this.source = source;
		this.tokens = tokenize(source, start);
		this.index = 0;
		this.depth = 0;
	}

	get token() {
		return this.tokens[this.index];
	}

	fail(message, token = this.token) {
		throw new ExpressionError(`${message} at position ${token.at}`);
	}

	isPunctuator(value) {
		return this.token.type === "punctuator" && this.token.value === value;
	}

	expect(value) {
		if (!this.isPunctuator(value)) {
			this.fail(`Expected "${value}"`);
		}
		this.index++;
	}

	nest(parse) {
		if (++this.depth > MAX_DEPTH) {
			this.fail("Expression is nested too deeply");
		}
		const node = parse();
		this.depth--;
		return node;
	}

	parseTernary() {
		return this.nest(() => {
			const test = this.parseBinary(0);
			if (!this.isPunctuator("?")) {
				return test;
			}
			this.index++;
			const consequent = this.parseTernary();
			this.expect(":");
			const alternate = this.parseTernary();
			return { type: "conditional", test, consequent, alternate };
		});
	}

	parseBinary(level) {
		if (level === BINARY_LEVELS.length) {
			return this.parseUnary();
		}
		let left = this.parseBinary(level + 1);
		while (this.token.type === "punctuator" && BINARY_LEVELS[level].includes(this.token.value)) {
			const operator = this.token.value;
			this.index++;
			const right = this.parseBinary(level + 1);
			left = { type: "binary", operator, left, right };
		}
		return left;
	}

	parseUnary() {
		return this.nest(() => {
			if (this.token.type === "punctuator" && ["!", "-", "+"].includes(this.token.value)) {
				const operator = this.token.value;
				this.index++;
				return { type: "unary", operator, argument: this.parseUnary() };
			}
			return this.parsePostfix();
		});
	}

	parsePostfix() {
		let node = this.parsePrimary();
		for (;;) {
			if (this.isPunctuator(".")) {
				this.index++;
				if (this.token.type !== "name") {
					this.fail("Expected a property name");
				}
				node = { type: "member", object: node, property: { type: "literal", value: this.token.value } };
				this.index++;
			} else if (this.isPunctuator("[")) {
				this.index++;
				const property = this.parseTernary();
				this.expect("]");
				node = { type: "member", object: node, property };
			} else if (this.isPunctuator("(")) {
				// Calls are only allowed on the named functions; a call on anything else is rejected by parsePrimary
				this.fail("Only the built-in functions can be called");
			} else {
				return node;
			}
		}
	}

	parseArguments() {
		const args = [];
		this.expect("(");
		if (!this.isPunctuator(")")) {
			do {
				args.push(this.parseTernary());
			} while (this.isPunctuator(",") && ++this.index);
		}
		this.expect(")");
		return args;
	}

	parsePrimary() {
		const token = this.token;

		if (token.type === "number" || token.type === "string") {
			this.index++;
			return { type: "literal", value: token.value };
		}
		if (this.isPunctuator("(")) {
			this.index++;
			const node = this.parseTernary();
			this.expect(")");
			return node;
		}
		if (token.type !== "name") {
			this.fail(token.type === "end" ? "Unexpected end of expression" : `Unexpected "${token.value}"`);
		}

		this.index++;
		const name = token.value;
		const literals = { true: true, false: false, null: null, undefined: undefined };

		if (Object.hasOwn(literals, name)) {
			return { type: "literal", value: literals[name] };
		}
		if (name === "value" || name === "state") {
			return { type: "scope", name };
		}
		if (name === "Math") {
			return this.parseMath(token);
		}
		if (Object.hasOwn(FUNCTIONS, name)) {
			if (!this.isPunctuator("(")) {
				this.fail(`"${name}" must be called`, token);
			}
			return { type: "call", callee: FUNCTIONS[name], args: this.parseArguments() };
		}
		return this.fail(`Unknown name "${name}"`, token);
	}

	parseMath(mathToken) {
		if (!this.isPunctuator(".")) {
			this.fail('"Math" must be followed by a function or constant', mathToken);
		}
		this.index++;
		const member = this.token;
		if (member.type !== "name") {
			this.fail("Expected a Math function or constant");
		}
		this.index++;

		if (MATH_CONSTANTS.includes(member.value)) {
			return { type: "literal", value: Math[member.value] };
		}
		if (!MATH_FUNCTIONS.includes(member.value)) {
			this.fail(`Math.${member.value} is not available`, member);
		}
		if (!this.isPunctuator("(")) {
			this.fail(`Math.${member.value} must be called`, member);
		}
		return { type: "call", callee: Math[member.value], args: this.parseArguments() };
	}
}

function read(object, key) {
	if (object === null || object === undefined) {
		return undefined;
	}
	if (typeof object === "string") {
		return key === "length" || (Number.isInteger(key) && key >= 0) ? object[key] : undefined;
	}
	if (typeof object === "object" && Object.hasOwn(object, key)) {
		return object[key];
	}
	return undefined;
}

const BINARY = {
	"+": (a, b) => a + b,
	"-": (a, b) => a - b,
	"*": (a, b) => a * b,
	"/": (a, b) => a / b,
	"%": (a, b) => a % b,
	"<": (a, b) => a < b,
	">": (a, b) => a > b,
	"<=": (a, b) => a <= b,
	">=": (a, b) => a >= b,
	"==": (a, b) => a == b,
	"!=": (a, b) => a != b,
	"===": (a, b) => a === b,
	"!==": (a, b) => a !== b,
};

function evaluate(node, scope) {
	switch (node.type) {
		case "literal":
			return node.value;
		case "scope":
			return scope[node.name];
		case "member":
			return read(evaluate(node.object, scope), evaluate(node.property, scope));
		case "call":
			return node.callee(...node.args.map((arg) => evaluate(arg, scope)));
		case "unary": {
			const argument = evaluate(node.argument, scope);
			return node.operator === "!" ? !argument : node.operator === "-" ? -argument : +argument;
		}
		case "conditional":
			return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);
		case "binary": {
			const left = evaluate(node.left, scope);
			if (node.operator === "&&") return left ? evaluate(node.right, scope) : left;
			if (node.operator === "||") return left ? left : evaluate(node.right, scope);
			if (node.operator === "??") return left ?? evaluate(node.right, scope);
			return BINARY[node.operator](left, evaluate(node.right, scope));
		}
		default:
			throw new ExpressionError(`Unknown node ${node.type}`);
	}
}

const expressions = new Map();

/**
 * Parses an expression once.
 * @param {string} source
 * @returns {(scope: {value?: *, state?: Object}) => *}
 * @throws {Error} with the position of the first problem
 */
function compileExpression(source) {
	if (!expressions.has(source)) {
		let ast;
		try {
			const parser = new Parser(source, 0);
			ast = parser.parseTernary();
			if (parser.token.type !== "end") {
				parser.fail(`Unexpected "${parser.token.value}"`);
			}
		} catch (error) {
			if (error instanceof ExpressionError) {
				throw new Error(`Invalid expression "${source}": ${error.message}`);
			}
			throw error;
		}
		expressions.set(source, (scope) => evaluate(ast, scope));
	}
	return expressions.get(source);
}

// Not a function body of its own: a template literal in sloppy mode, as the 1.x templates were evaluated
function evaluateWithEval(template, value, state) {
	return eval("`" + template + "`");
}

const templates = new Map();

/**
 * Compiles a URL or body template: `${...}` parts are expressions and `{value}` becomes the mapped value.
 * @param {string} template
 * @param {{unsafe?: boolean}} [options] `unsafe` evaluates `${...}` as full JavaScript (allowUnsafeEval)
 * @returns {(scope: {value?: *, state?: Object, mappedValue?: *}) => string}
 */
function compileTemplate(template, { unsafe = false } = {}) {
	const key = `${unsafe ? "unsafe" : "safe"}:${template}`;
	if (templates.has(key)) {
		return templates.get(key);
	}

	let render;
	if (unsafe) {
		render = (scope) => evaluateWithEval(template, scope.value, scope.state);
	} else {
		const parts = [];
		let position = 0;
		for (let start = template.indexOf("${"); start !== -1; start = template.indexOf("${", position)) {
			parts.push(template.slice(position, start));
			let parser;
			let ast;
			try {
				parser = new Parser(template, start + 2);
				ast = parser.parseTernary();
				if (!parser.isPunctuator("}")) {
					parser.fail('Expected "}"');
				}
			} catch (error) {
				if (error instanceof ExpressionError) {
					throw new Error(`Invalid template "${template}": ${error.message}`);
				}
				throw error;
			}
			parts.push(ast);
			position = parser.token.at + 1;
		}
		parts.push(template.slice(position));

		render = (scope) => parts.map((part) => (typeof part === "string" ? part : String(evaluate(part, scope)))).join("");
	}

	const compiled = (scope) => render(scope).replace(/{value}/gi, () => String(scope.mappedValue));
	templates.set(key, compiled);
	return compiled;
}

module.exports = { compileExpression, compileTemplate, toNumber };

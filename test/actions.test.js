const { createAction, createActions } = require("../src/actions.js");
const { StaticMapper, RegexMapper, EvalMapper } = require("../src/mappers/index.js");

test("applies defaults", () => {
	expect(createAction({ url: "http://h/a" })).toEqual({
		url: "http://h/a",
		httpMethod: "GET",
		body: "",
		resultOnError: undefined,
	});
});

test("keeps method, body and resultOnError", () => {
	const action = createAction({ url: "http://h/a", httpMethod: "POST", body: "x", resultOnError: "0" });
	expect(action).toMatchObject({ httpMethod: "POST", body: "x", resultOnError: "0" });
});

test("builds mappers from their definitions", () => {
	const action = createAction({
		url: "http://h/a",
		mappers: [
			{ type: "regex", parameters: { regexp: "(\\d)" } },
			{ type: "static", parameters: { mapping: { 1: "on" } } },
		],
	});
	expect(action.mappers[0]).toBeInstanceOf(RegexMapper);
	expect(action.mappers[1]).toBeInstanceOf(StaticMapper);
});

test("gives eval mappers access to the shared state", () => {
	const state = { getOn: "1" };
	const action = createAction(
		{ url: "u", mappers: [{ type: "eval", parameters: { expression: "self.state.getOn + value" } }] },
		{ state }
	);
	expect(action.mappers[0]).toBeInstanceOf(EvalMapper);
	expect(action.mappers[0].map("2")).toBe("12");
});

test("skips unknown mapper types and reports them", () => {
	const warn = jest.fn();
	const action = createAction({ url: "u", mappers: [{ type: "nope", parameters: {} }] }, { warn });
	expect(action.mappers).toEqual([]);
	expect(warn).toHaveBeenCalledWith('Unknown mapper type "nope" ignored');
});

test("does not treat inherited names as mapper types", () => {
	const action = createAction({ url: "u", mappers: [{ type: "constructor", parameters: {} }] });
	expect(action.mappers).toEqual([]);
});

test("builds nested inconclusive actions", () => {
	const action = createAction({ url: "a", inconclusive: { url: "b", inconclusive: { url: "c" } } });
	expect(action.inconclusive.url).toBe("b");
	expect(action.inconclusive.inconclusive.url).toBe("c");
});

test("createActions keys actions by name and tolerates a missing urls section", () => {
	const actions = createActions({ getOn: { url: "a" }, setOn: { url: "b" } });
	expect(Object.keys(actions)).toEqual(["getOn", "setOn"]);
	expect(createActions(undefined)).toEqual({});
});

const mappers = require("../mappers.js");

const p = { 
    "mapping": {
        "STAY": "0",
        "AWAY": "1",
        "INT": 1234353,
    }
}
const staticMapper = new mappers.StaticMapper(p)

test.each`
    a           | expected
    ${"STAY"}   | ${"0"}
    ${"AWAY"}   | ${"1"}
    ${"N/A"}    | ${"N/A"}
    ${"INT"}    | ${1234353}
`('returns $expected when $a given', ({a, expected}) => {
    expect(staticMapper.map(a)).toBe(expected);
});

const remap = "Math.round((value - 30) * (100 - 0) / (99 - 30) + 0)"

test.each`
    a                               | b         | expected
    ${"2 + value"}                  | ${1}      | ${3}
    ${"value < 30 ? 0 : " + remap}  | ${10}     | ${0} 
    ${"value < 30 ? 0 : " + remap}  | ${50}     | ${29} 
    ${"value < 30 ? 0 : " + remap}  | ${99}     | ${100} 
    ${"value === \"OK\" ? 1 : 0"}     | ${"OK"}   | ${1}
`('returns $expected when value is $b and expression is $a', ({a, b, expected}) => {
    const p = {
        "expression": a
    }
    const evalMapper = new mappers.EvalMapper(p)

    expect(evalMapper.map(b)).toBe(expected);
});


describe("StaticMapper edge cases", () => {
    test("returns a mapped falsy value", () => {
        const m = new mappers.StaticMapper({ mapping: { OFF: 0, EMPTY: "" } });
        expect(m.map("OFF")).toBe(0);
        expect(m.map("EMPTY")).toBe("");
    });
});

describe("RegexMapper", () => {
    test("returns the requested capture group", () => {
        const m = new mappers.RegexMapper({ regexp: "mode=(\\d)", capture: "1" });
        expect(m.map("pow=1,mode=4,stemp=21")).toBe("4");
    });

    test("returns the input when the regexp does not match", () => {
        const m = new mappers.RegexMapper({ regexp: "mode=(\\d)" });
        expect(m.map("nothing here")).toBe("nothing here");
    });

    test("returns the input when the capture group does not exist", () => {
        const m = new mappers.RegexMapper({ regexp: "mode=(\\d)", capture: "5" });
        expect(m.map("mode=4")).toBe("mode=4");
    });
});

describe("XPathMapper", () => {
    const xml = "<root><p>ARMED</p><p>DISARMED</p><p>ALARM</p></root>";

    test("selects a text node", () => {
        const m = new mappers.XPathMapper({ xpath: "//p[3]/text()" });
        expect(m.map(xml)).toBe("ALARM");
    });

    test("honours index when several nodes match", () => {
        const m = new mappers.XPathMapper({ xpath: "//p/text()", index: 1 });
        expect(m.map(xml)).toBe("DISARMED");
    });

    test("returns the input when nothing matches", () => {
        const m = new mappers.XPathMapper({ xpath: "//missing/text()" });
        expect(m.map(xml)).toBe(xml);
    });
});

describe("JPathMapper", () => {
    test("selects a value", () => {
        const m = new mappers.JPathMapper({ jpath: "$.data.co2" });
        expect(m.map('{"data":{"co2":612}}')).toBe(612);
    });

    test("honours index and supports recursive descent ($..)", () => {
        const m = new mappers.JPathMapper({ jpath: "$..power", index: "0" });
        expect(m.map('{"zone":{"power":"on"}}')).toBe("on");
    });

    test("serialises object results", () => {
        const m = new mappers.JPathMapper({ jpath: "$.a" });
        expect(m.map('{"a":{"b":1}}')).toBe('{"b":1}');
    });

    test("returns 'inconclusive' for invalid JSON", () => {
        const m = new mappers.JPathMapper({ jpath: "$.a" });
        expect(m.map("<xml/>")).toBe("inconclusive");
    });

    test("returns 'inconclusive' for non-object JSON", () => {
        const m = new mappers.JPathMapper({ jpath: "$.a" });
        expect(m.map("42")).toBe("inconclusive");
    });

    const doc = '{"items":[{"n":1},{"n":2},{"n":3}],"status":{"power":"on"}}';

    test.each`
        jpath                   | index | expected
        ${"$.items[*].n"}       | ${1}  | ${2}
        ${"$..n"}               | ${2}  | ${3}
        ${"$.items[1].n"}       | ${0}  | ${2}
        ${"$..[?(@.n>1)].n"}    | ${0}  | ${2}
        ${"$.status.power"}     | ${0}  | ${"on"}
    `("$jpath (index $index) selects $expected", ({ jpath, index, expected }) => {
        expect(new mappers.JPathMapper({ jpath, index }).map(doc)).toBe(expected);
    });

    test("an expression without a match yields an empty array", () => {
        const m = new mappers.JPathMapper({ jpath: "$.missing" });
        expect(m.map(doc)).toBe("[]");
    });
});

describe("XPathMapper with an XML declaration", () => {
    test("parses ISO-8859-1 documents", () => {
        const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><partitionsStatus><partition>ARMED</partition><partition>ARMED_IMMEDIATE</partition></partitionsStatus>';
        const m = new mappers.XPathMapper({ xpath: "//partition[2]/text()" });
        expect(m.map(xml)).toBe("ARMED_IMMEDIATE");
    });
});

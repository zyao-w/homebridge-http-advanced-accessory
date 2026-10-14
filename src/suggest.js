const { DOMParser } = require("@xmldom/xmldom");

const MAX_SUGGESTIONS = 60;
const MAX_DEPTH = 8;
const MAX_ITEMS = 20;
const MAX_SAMPLE = 80;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

const sample = (value) => String(value).slice(0, MAX_SAMPLE);

function jsonKey(key) {
	return IDENTIFIER.test(key) ? `.${key}` : `['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function jsonSuggestions(root) {
	const found = [];
	const walk = (node, path, depth) => {
		if (found.length >= MAX_SUGGESTIONS || depth > MAX_DEPTH) return;
		if (Array.isArray(node)) {
			node.slice(0, MAX_ITEMS).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
		} else if (node !== null && typeof node === "object") {
			for (const key of Object.keys(node)) walk(node[key], path + jsonKey(key), depth + 1);
		} else if (node !== null && node !== undefined) {
			found.push({ type: "jpath", path, sample: sample(node) });
		}
	};
	walk(root, "$", 0);
	return found;
}

const childElements = (node) => {
	const children = [];
	for (let i = 0; i < node.childNodes.length; i++) {
		if (node.childNodes.item(i).nodeType === ELEMENT) children.push(node.childNodes.item(i));
	}
	return children;
};

function textOf(element) {
	let text = "";
	for (let i = 0; i < element.childNodes.length; i++) {
		const child = element.childNodes.item(i);
		if (child.nodeType === TEXT || child.nodeType === CDATA) text += child.data;
		else if (child.nodeType === ELEMENT) return undefined;
	}
	return text.trim() === "" ? undefined : text;
}

function xmlSuggestions(document) {
	const found = [];
	const walk = (element, path, depth) => {
		if (found.length >= MAX_SUGGESTIONS || depth > MAX_DEPTH) return;
		const children = childElements(element);
		if (children.length === 0) {
			const text = textOf(element);
			if (text !== undefined) found.push({ type: "xpath", path: `${path}/text()`, sample: sample(text.trim()) });
			return;
		}
		const counts = new Map();
		for (const child of children) counts.set(child.tagName, (counts.get(child.tagName) || 0) + 1);
		const seen = new Map();
		for (const child of children.slice(0, MAX_ITEMS * 3)) {
			const position = (seen.get(child.tagName) || 0) + 1;
			seen.set(child.tagName, position);
			// A position is only written where the parent has several elements with that name
			const step = counts.get(child.tagName) > 1 ? `${child.tagName}[${position}]` : child.tagName;
			walk(child, `${path}/${step}`, depth + 1);
		}
	};
	if (document && document.documentElement) {
		walk(document.documentElement, `/${document.documentElement.tagName}`, 0);
	}
	return found;
}

/**
 * Lists the values of a response that a mapper could pick, for the setup wizard.
 * JSON gives JSONPath expressions and XML gives XPath expressions, each with the value it selects.
 *
 * @param {string} body The text of an HTTP response
 * @returns {{format: "json"|"xml"|"text", suggestions: Array<{type: "jpath"|"xpath", path: string, sample: string}>}}
 */
function suggestPaths(body) {
	const text = typeof body === "string" ? body.trim() : "";

	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			return { format: "json", suggestions: jsonSuggestions(JSON.parse(text)) };
		} catch {
			// Not JSON after all
		}
	}
	if (text.startsWith("<")) {
		try {
			const document = new DOMParser({ onError: () => {} }).parseFromString(text, "text/xml");
			return { format: "xml", suggestions: xmlSuggestions(document) };
		} catch {
			// Not XML after all
		}
	}
	return { format: "text", suggestions: [] };
}

module.exports = { suggestPaths };

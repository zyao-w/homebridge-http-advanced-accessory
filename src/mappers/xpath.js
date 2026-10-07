const xpath = require("xpath");
const { DOMParser } = require("@xmldom/xmldom");

/** Selects the text of a node with an XPath expression. */
class XPathMapper {
	constructor(parameters) {
		this.xpath = parameters.xpath;
		this.index = parameters.index || 0;
	}

	map(value) {
		const document = new DOMParser().parseFromString(value, "text/xml");
		const result = xpath.select(this.xpath, document);

		if (typeof result == "string") {
			return result;
		} else if (Array.isArray(result) && result.length > this.index) {
			return result[this.index].data;
		}

		return value;
	}
}

module.exports = XPathMapper;

/** Extracts a capture group of a regular expression, or returns the input when it does not match. */
class RegexMapper {
	constructor(parameters) {
		this.regexp = new RegExp(parameters.regexp);
		this.capture = parameters.capture || "1";
	}

	map(value) {
		const matches = this.regexp.exec(value);

		if (matches !== null && this.capture in matches) {
			return matches[this.capture];
		}

		return value;
	}
}

module.exports = RegexMapper;

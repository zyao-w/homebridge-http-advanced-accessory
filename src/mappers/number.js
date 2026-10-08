const { INCONCLUSIVE } = require("./constants.js");

/**
 * Turns the input into a number. Anything that is not a number (offline, an empty answer, null, 12px) is
 * "inconclusive", so a fallback action can take over or the request fails, and no made-up value reaches HomeKit.
 */
class NumberMapper {
	constructor(parameters) {
		const round =
			typeof parameters.round === "string" && parameters.round.trim() !== ""
				? Number(parameters.round)
				: parameters.round;
		if (round !== undefined && round !== null && !(Number.isInteger(round) && round >= 0 && round <= 10)) {
			throw new Error('"round" of a "number" mapper must be a whole number from 0 to 10');
		}
		this.round = round === null ? undefined : round;
	}

	map(value) {
		const input = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
		if (typeof input !== "number" || !Number.isFinite(input)) {
			return INCONCLUSIVE;
		}

		if (this.round === undefined) {
			return input;
		}
		const factor = 10 ** this.round;
		const rounded = Math.round(input * factor) / factor;
		return rounded === 0 ? 0 : rounded;
	}
}

module.exports = NumberMapper;

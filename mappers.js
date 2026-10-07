var xpath = require("xpath");
var dom = require("@xmldom/xmldom").DOMParser;
var JSONPath = require("jsonpath-plus").JSONPath;

module.exports = {
    StaticMapper,
    RegexMapper,
    XPathMapper,
    JPathMapper,
    EvalMapper,
}

/**
 * Mapper class that can be used as a dictionary for mapping one value to another
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function StaticMapper(parameters) {
	var self = this;
	self.mapping = parameters.mapping;

	self.map = function(value) {
		return Object.prototype.hasOwnProperty.call(self.mapping, value) ? self.mapping[value] : value;
	};
}

/**
 * Mapper class that can extract a part of the string using a regex
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function RegexMapper(parameters) {
	var self = this;
	self.regexp = new RegExp(parameters.regexp);
	self.capture = parameters.capture || "1";

	self.map = function(value) {
		var matches = self.regexp.exec(value);

		if (matches !== null && self.capture in matches) {
			return matches[self.capture];
		}

		return value;
	};
}

/**
 * Mapper class that uses XPath to select the text of a node or the value of an attribute
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function XPathMapper(parameters) {
	var self = this;
	self.xpath = parameters.xpath;
	self.index = parameters.index || 0;

	self.map = function(value) {
		var document = new dom().parseFromString(value, "text/xml");
		var result  = xpath.select(self.xpath, document);

		if (typeof result == "string") {
			return result;
		} else if (result instanceof Array && result.length > self.index) {
			return result[self.index].data;
		}

		return value;
	};
}

/**
 * Mapper class that uses JSONPath to select the text of a node or the value of an attribute
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function JPathMapper(parameters) {
	var self = this;
	self.jpath = parameters.jpath;
	self.index = parameters.index || 0;
        
	self.map = function(value) {
	  var result = 'inconclusive';
	  var json;
	  
	  try {
	    json = JSON.parse(value);
	    } catch (e) {
	    return result;
	    }

        if (typeof json !== 'object') {
          return result;
        } else {
          result = JSONPath({path: self.jpath, json: json});
          if (result instanceof Array && result.length > self.index) {
	        result = result[self.index];
	        }
	      if (result instanceof Object) {
	        result = JSON.stringify(result);
	        }
	      }

	return result;
	}
}

/**
 * Mapper class that evaluates the given js string
 *
 * @param {Object} parameters The parameters of the mapper
 * @constructor
 */
function EvalMapper(parameters) {
	var self = this;
	self.exp = parameters.expression;

	self.map = function(value) {
		var result = eval(self.exp);

		return result;
	};
}

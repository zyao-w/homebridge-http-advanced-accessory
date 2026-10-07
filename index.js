var Service, Characteristic;
var mappers = require("./src/mappers/index.js");
var resolveBearerToken = require("./src/http/auth.js").resolveBearerToken;
var HttpClient = require("./src/http/client.js");
var Poller = require("./src/poller.js");

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory("homebridge-http-advanced-accessory-zyao", "HttpAdvancedAccessory", HttpAdvancedAccessory);
};

function HttpAdvancedAccessory(log, config) {
	this.log = log;
	this.name = config.name;
	this.service = config.service;
	this.optionCharacteristic = config.optionCharacteristic || [];
	this.props = config.props || {};
	this.forceRefreshDelay = config.forceRefreshDelay || 0;
	this.setterDelay  = config.setterDelay || 0;
	this.enableSet = true;
	this.statusEmitters = {};
	this.state = {};
	// process the mappers
	var self = this;
	self.debug = config.debug;
	/**
	 * self.urls ={
	 *	getStatus : {
	 *		url:"http://",
	 *		httpMethod:"",
	 *		mappers : [],
	 *      inconclusive : {
	 * 			url:
	 * 			httpMethods:"",
	 * 			mappers[]
	 * 		}
	 *	},
	 *	getTemp : {
	 *		url:"http://",
	 *		httpMethod:"",
	 *		mappers : []
	 *	},
	 *  setTemp : {
	 * 		url:"http://{value}",
	 * 		httpMethod:"",
	 *      body:"{value}",
	 * 		mappers : []
	 * }
	 *}
	 */
	function createAction(action, actionDescription){
		action.url = actionDescription.url;
		action.httpMethod = actionDescription.httpMethod || "GET";
		action.body = actionDescription.body || "";
		action.resultOnError = actionDescription.resultOnError;
		if (actionDescription.mappers) {
			action.mappers = [];
			actionDescription.mappers.forEach(function(matches) {
				switch (matches.type) {
					case "regex":
						action.mappers.push(new mappers.RegexMapper(matches.parameters));
						break;
					case "static":
						action.mappers.push(new mappers.StaticMapper(matches.parameters));
						break;
					case "xpath":
						action.mappers.push(new mappers.XPathMapper(matches.parameters));
						break;
					case "jpath":
						action.mappers.push(new mappers.JPathMapper(matches.parameters));
						break;
					case "eval":
						var mapper = new mappers.EvalMapper(matches.parameters);
						mapper.state = self.state;
						action.mappers.push(mapper);
						break;
				}
			});
		}
		if(actionDescription.inconclusive){
			action.inconclusive = {};
			createAction(action.inconclusive, actionDescription.inconclusive);
		}
	};
	self.urls ={};
	if(config.urls){
		for (var actionName in config.urls){
			if(!config.urls.hasOwnProperty(actionName)) continue;
			self.urls[actionName] = {};
			createAction(self.urls[actionName],config.urls[actionName]);
		}

	}
	self.auth = {
		username: config.username || "",
		password: config.password || "",
		bearerToken: "",
		bearerTokenError: null,
		immediately: true
	};

	try {
		self.auth.bearerToken = resolveBearerToken(config.bearerToken);
	} catch (e) {
		self.auth.bearerTokenError = e;
		self.log("ERROR: " + e.message);
	}

	if ("immediately" in config) {
		self.auth.immediately = config.immediately;
	}

	self.client = new HttpClient({
		auth: self.auth,
		timeout: config.timeout,
		retries: config.retries,
		cacheTTL: config.cacheTTL !== undefined ? config.cacheTTL : self.forceRefreshDelay,
		maxConcurrent: config.maxConcurrent,
		uriCallsDelay: config.uriCallsDelay
	});
	self.poller = new Poller({ log: function (message) { self.debugLog(message); } });
}



HttpAdvancedAccessory.prototype = {
	/**
 * Logs a message to the HomeBridge log
 *
 * Only logs the message if the debug flag is on.
 */
	debugLog : function () {
		if (this.debug) {
			this.log.apply(this, arguments);
		}
	},
/**
 * Performs a read request. Identical in-flight reads are shared and responses are cached for `cacheTTL`.
 *
 * @param action The action holding url, httpMethod and body
 * @param options { fresh: true } skips the cache lookup
 * @returns {Promise<{status: number, body: string}>}
 */
	readRequest : function(action, options) {
		if (this.auth.bearerTokenError) {
			// Fail instead of silently falling back to Basic auth with empty credentials
			return Promise.reject(this.auth.bearerTokenError);
		}

		return this.client.read({ url: action.url, method: action.httpMethod, body: action.body }, options);
	},

/**
 * Performs a write request. Never shared, cached or retried.
 *
 * @returns {Promise<{status: number, body: string}>}
 */
	writeRequest : function(url, body, httpMethod) {
		if (this.auth.bearerTokenError) {
			return Promise.reject(this.auth.bearerTokenError);
		}

		return this.client.write({ url: url, method: httpMethod, body: body });
	},

/**
 * Applies the mappers to the state string received
 *
 * @param {string} string The string to apply the mappers to
 * @returns {string} The modified string after all mappers have been applied
 */
	applyMappers : function(mappers, string) {
		var self = this;

		if (mappers && mappers.length > 0) {
			self.debugLog("Applying mappers on " + string);
			mappers.forEach(function (mapper, index) {
				var newString = mapper.map(string);
				self.debugLog("Mapper " + index + " mapped " + string + " to " + newString);
				string = newString;
			});

			self.debugLog("Mapping result is " + string);
		}

		return string;
	},

	stringInject : function(str, data) {
		if (typeof str === 'string' && (data instanceof Array)) {
	
			return str.replace(/({\d})/g, function(i) {
				return data[i.replace(/{/, '').replace(/}/, '')];
			});
		} else if (typeof str === 'string' && (data instanceof Object)) {
	
			for (let key in data) {
				return str.replace(/({([^}]+)})/g, function(i) {
					let key = i.replace(/{/, '').replace(/}/, '');
					if (!data[key]) {
						return i;
					}
	
					return data[key];
				});
			}
		} else {
	
			return false;
		}
	},

	//Start
	identify: function (callback) {
		this.log("Identify requested!");
		callback(null);
	},
	getName: function (callback) {
		this.log("getName :", this.name);
		var error = null;
		callback(error, this.name);
	},
	
	getServices: function () {
		// Turns the outcome of a request ({ body } or { error }) into the characteristic value
		var interpret = function (action, outcome, callback) {
			var error = outcome.error;
			if (error && action.resultOnError != null) {
				this.debugLog("GetState function failed BUT using resultOnError=%s: %s", action.resultOnError, error.message);
				callback(null, action.resultOnError);
			} else if (error) {
				this.log("GetState function failed: %s", error.message);
				callback(error);
			} else {
				this.debugLog("received response from action: %s", action.url);
				var responseBody = outcome.body;
				var state = this.applyMappers(action.mappers, responseBody);
				if (state == "inconclusive") {
					this.log(`Inconclusive mapping of response "${responseBody}"`);
					if (action.inconclusive) {
						this.debugLog("Response inconclusive and trying the action specified for this condition.");
						getDispatch(callback, action.inconclusive);
					} else {
						this.debugLog("Response inconclusive with no further action specified for this condition.");
					}
				} else {
					this.debugLog("We have a value: %s, int: %d", state, parseInt(state));
					callback(null, state);
				}
			}
		}.bind(this);

		var getDispatch = function (callback, action) {
			if (typeof action == "undefined") {
				callback(null);
				return;
			}
			this.debugLog("getDispatch function called for url: %s", action.url);
			this.readRequest(action).then(function (response) {
				interpret(action, { body: response.body }, callback);
			}, function (error) {
				interpret(action, { error: error }, callback);
			}).catch(function (error) {
				this.log("Unexpected error in getter: %s", error && error.message);
			}.bind(this));
		}.bind(this);

		var setDispatch = function (value, callback, characteristic) {
			if (this.enableSet == false) { callback() }
			else {
				var actionName = "set" + characteristic.displayName.replace(/\s/g, '')
				this.debugLog("setDispatch:actionName:value: ", actionName, value); 
				var action = this.urls[actionName];
				if (!action || !action.url) {
					callback(null);
					return;
				}
				// eslint-disable-next-line no-unused-vars -- referenced by the eval'd URL/body templates
				var state = this.state;
				var body = action.body;
				var mappedValue = this.applyMappers(action.mappers, value);
				var url = eval('`'+action.url+'`').replace(/{value}/gi, mappedValue);
				if (body) {
					body = eval('`'+body+'`').replace(/{value}/gi, mappedValue);
				}

				this.writeRequest(url, body, action.httpMethod).then(function () {
					// https://github.com/KhaosT/HAP-NodeJS/blob/master/lib/Characteristic.js#L34 setter callback takes only error as arg
					if (callback) callback();
				}, function (error) {
					this.log("SetState function failed: %s", error.message);
					if (callback) callback(error);
				}.bind(this)).catch(function (error) {
					this.log("Unexpected error in setter: %s", error && error.message);
				}.bind(this));

			}
		}.bind(this);

		// you can OPTIONALLY create an information service if you wish to override / the default values for things like serial number, model, etc.
		var informationService = new Service.AccessoryInformation();

		informationService
			.setCharacteristic(Characteristic.Manufacturer, "Custom Manufacturer")
			.setCharacteristic(Characteristic.Model, "HTTP Accessory Model")
			.setCharacteristic(Characteristic.SerialNumber, "HTTP Accessory Serial Number");

		
		var newService = new Service[this.service](this.name);

		var counters = [];
		var optionCounters = [];


		for (var characteristicIndex in newService.characteristics) 
		{
			var characteristic = newService.characteristics[characteristicIndex];
			var compactName = characteristic.displayName.replace(/\s/g, '');
			
			if (compactName in this.props) {
				characteristic.setProps(this.props[compactName]);
			}
			
			counters[characteristicIndex] = makeHelper(characteristic);
			characteristic.on('get', counters[characteristicIndex].getter.bind(this))
			characteristic.on('set', counters[characteristicIndex].setter.bind(this));
		}

		for (var characteristicIndex in newService.optionalCharacteristics) 
		{
			var characteristic = newService.optionalCharacteristics[characteristicIndex];
			var compactName = characteristic.displayName.replace(/\s/g, '');
			
			if (compactName in this.props) {
				characteristic.setProps(this.props[compactName]);
			}
			
			if(this.optionCharacteristic.indexOf(compactName) == -1)
			{
				continue;
			}

			optionCounters[characteristicIndex] = makeHelper(characteristic);
			characteristic.on('get', optionCounters[characteristicIndex].getter.bind(this))
			characteristic.on('set', optionCounters[characteristicIndex].setter.bind(this));

			newService.addCharacteristic(characteristic);
		}
	
		function makeHelper(characteristic) {
			var timeoutID = null;
			return {
				getter: function (callback) {
					var actionName = "get" + characteristic.displayName.replace(/\s/g, '');
					if(actionName == "getName"){
						callback (null, this.name);
						return;
					}
					var action = this.urls[actionName];
					if (this.forceRefreshDelay == 0 ) { 
						getDispatch(function(error,data){
							this.debugLog(actionName + " getter function returned with data: " + data);
							this.enableSet = false;
							this.state[actionName] = data;
							characteristic.setValue(data);
							this.enableSet = true;
							callback(error,data);
						}.bind(this), action); 
					} 
					else {
						
						callback(null,this.state[actionName] || characteristic.value);

						if (typeof this.statusEmitters[actionName] != "undefined"){
							this.debugLog(actionName + " returning cached data: " + this.state[actionName]);
							return;
						} 
						if (typeof action == "undefined") {
							// Nothing to poll without a getter action
							return;
						}
						this.debugLog("creating new poller for " + actionName);

						var onData = function (error, data) {
							if (error) {
								this.log("Poller errored: %s", error.message);
								return;
							}
							this.debugLog(actionName + " poller returned data: " + data);
							this.enableSet = false;
							
							if (['int', 'uint16', 'uint8', 'uint32', 'uint64'].includes(characteristic.props.format))
								data = parseInt(data);
							if ('float' == characteristic.props.format)
								data = parseFloat(data);

							this.state[actionName] = data;
							characteristic.setValue(data);
							this.enableSet = true;
						}.bind(this);

						// Actions that issue the same request share one poll
						var pollKey = this.client.keyFor({ url: action.url, method: action.httpMethod, body: action.body });
						this.statusEmitters[actionName] = this.poller.subscribe(pollKey, {
							poll: function () {
								this.debugLog("requested update for action " + actionName);
								return this.readRequest(action, { fresh: true });
							}.bind(this),
							intervalMs: this.forceRefreshDelay * 1000
						}, {
							onResult: function (response) {
								interpret(action, { body: response.body }, onData);
							},
							onError: function (error) {
								interpret(action, { error: error }, onData);
							}
						});
						
					}
				},
				setter: function (value, callback) { 
					if (this.enableSet == false || this.setterDelay === 0) {
						// no setter delay or internal set - do it immediately 
						this.debugLog("updating " + characteristic.displayName.replace(/\s/g, '') + " with value " + value);
						setDispatch(value, callback, characteristic);
					} else {
						// making a request and setter delay is set
						// optimistic callback calling if we have a delay
						// this also means we won't be getting back any errors in homekit
						callback();
						
						this.debugLog("updating " + characteristic.displayName.replace(/\s/g, '') + " with value " + value + " in " + this.setterDelay + "ms");
						if(timeoutID != null) {
							clearTimeout(timeoutID); 
							this.debugLog("clearing timeout for setter " + characteristic.displayName.replace(/\s/g, ''));
						}
						timeoutID = setTimeout(function(){setDispatch(value, null, characteristic);timeoutID=null;}.bind(this), this.setterDelay);
					}	
				}
			};
		}
		return [informationService, newService];
	}
};

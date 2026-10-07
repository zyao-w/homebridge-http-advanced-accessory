var Service, Characteristic;
var request = require("request");
var pollingtoevent = require("polling-to-event");
var mappers = require("./mappers.js");

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
	this.statusEmitters = [];
	this.state = {};
	this.uriCalls=0;
	this.uriCallsDelay = config.uriCallsDelay || 0;
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
		bearerToken: config.bearerToken || "",
		immediately: true
	};

	if ("immediately" in config) {
		self.auth.immediately = config.immediately;
	}


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
 * Method that performs a HTTP request
 *
 * @param url The URL to hit
 * @param body The body of the request
 * @param callback Callback method to call with the result or error (error, response, body)
 */
	httpRequest : function(url, body, httpMethod, callback) {
		var self = this;

		setTimeout(
			function() {
				var headers = {};

				if (self.auth.bearerToken) {
					headers.Authorization = "Bearer " + self.auth.bearerToken;
				} else {
					headers.Authorization = "Basic " +
						new Buffer(
							self.auth.username + ":" + self.auth.password
						).toString("base64");
				}

				request({
					url: url,
					body: body,
					method: httpMethod,

					auth: self.auth.bearerToken ? undefined : {
						user: self.auth.username,
						pass: self.auth.password,
						sendImmediately: self.auth.immediately
					},

					headers: headers
				},
				function(error, response, body) {
					self.uriCalls--;

					self.debugLog(
						"httpRequest ended, current uriCalls is " +
						self.uriCalls
					);

					callback(error, response, body);
				});
			},
			this.uriCalls * this.uriCallsDelay
		);

		this.uriCalls++;

		this.debugLog(
			"httpRequest called, current uriCalls is " +
			this.uriCalls
		);
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
		var getDispatch = function (callback, action) {
			if (typeof action == "undefined") {
				callback(null);
				return;
			}
			this.debugLog("getDispatch function called for url: %s", action.url);
			this.httpRequest(action.url, action.body, action.httpMethod, function(error, response, responseBody) {
				if (error && action.resultOnError != null) {
					this.debugLog("GetState function failed BUT using resultOnError=%s: %s", action.resultOnError, error.message);
					callback(null, action.resultOnError);
				} else if (error) {
					this.log("GetState function failed: %s", error.message);
					callback(error);
				} else {
					this.debugLog("received response from action: %s", action.url);
					var state = responseBody;
					state = this.applyMappers(action.mappers,state);
					if (state == "inconclusive") {
					   this.log(`Inconclusive mapping of response "${responseBody}"`);
					   if (action.inconclusive){
					     this.debugLog("Response inconclusive and trying the action specified for this condition.");
					     getDispatch(callback,action.inconclusive);
					   } else {
					     this.debugLog("Response inconclusive with no further action specified for this condition.");
					     }
					} else {
						this.debugLog("We have a value: %s, int: %d", state, parseInt(state));
						callback(null, state);
					}
				}
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

				this.httpRequest(url, body, action.httpMethod, function(error, response, responseBody) {
					if (error) {
						this.log("SetState function failed: %s", error.message);
					}
					if (callback) {
						if (error) {
							callback(error);
						} else {
							// https://github.com/KhaosT/HAP-NodeJS/blob/master/lib/Characteristic.js#L34 setter callback takes only error as arg
							callback(); 
						}	
					}
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
						this.debugLog("creating new emitter for " + actionName);

						this.statusEmitters[actionName] = pollingtoevent(function (done) {
							this.debugLog("requested update for action " + actionName);
							getDispatch(done,action);

						}.bind(this), { 
							longpolling: true, 
							interval: this.forceRefreshDelay * 1000, 
							longpollEventName: actionName 
						});

						this.statusEmitters[actionName].on(actionName, function (data) 
						{
							this.debugLog(actionName + " emitter returned data: " + data);
							this.enableSet = false;
							
							if (['int', 'uint16', 'uint8', 'uint32', 'uint64'].includes(characteristic.props.format))
								data = parseInt(data);
							if ('float' == characteristic.props.format)
								data = parseFloat(data);

							this.state[actionName] = data;
							characteristic.setValue(data);
							this.enableSet = true;

						}.bind(this));

						this.statusEmitters[actionName].on("error", function(err, data) {
							this.log("Emitter errored: %s. with data %j", err, data);
						}.bind(this));
						
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

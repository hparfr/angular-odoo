'use strict';

(function (ak) {

	var cookies = (function() {
		var session_id; //cookies doesn't work with Android Default Browser / Ionic
		return {
			delete_sessionId: function() {
				session_id = null;
				document.cookie  = 'session_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
			},
			get_sessionId: function () {
				return document.cookie.split('; ')
				.filter(function (x) { return x.indexOf('session_id') === 0; })
				.map(function (x) { return x.split('=')[1]; })
				.pop() || session_id || "";
			},
			set_sessionId: function (val) {
				document.cookie = 'session_id=' + val;
				session_id = val;
			}
		};
	}());


	ak.OdooModule = ng.core.NgModule(
	{
		//imports: [],
		bootstrap: [],
		imports: [ ng.http.HttpModule]
	}).Class({
		constructor: function() {
		}
	});
	ak.odooService = ng.core.Class({
		constructor: [ng.http.Http, function(http) {
			this.http = http;
			this.preflightPromise = null;
			this.errorInterceptors = [];

		}],
		/**
		* login
		*		update cookie (session_id) in both cases
		* @return promise
		*		resolve promise if credentials ok
		*		reject promise if credentials ko (with {title: wrong_login})
		*		reject promise in other cases (http issues, server error)   
		*/
		login: function(db, login, password) {
			var params = {
				db: db,
				login: login,
				password: password
			};
			var self = this;
			return this.sendRequest('/web/session/authenticate', params).then(function(result) {
				if (!result.uid) {
					if (self.shouldManageSessionId)
						cookies.delete_sessionId();
	
					return Promise.reject({ 
						title: 'wrong_login',
						message:"Username and password don't match",
						fullTrace: result
					});
				}
				self.context = result.user_context;
				if (self.shouldManageSessionId)
					cookies.set_sessionId(result.session_id);
				return result;
			});
		},

		/**
		* logout
		* @return promise 
		*/
		logout: function () {
			var self = this;
			if (self.shouldManageSessionId)
				cookies.delete_sessionId();
			return self.getSessionInfo().then(function (r) { //get db from sessionInfo
				if (r.db)
					return self.login(r.db, '', '').then(null, function (res) {
						if (res.title !="wrong_login")
							return Promise.reject(res);
					});
				else
					return self.sendRequest('/web/session/destroy').then(null,
						function (err) {
							console.log('err', err);
						});
			});
		},

		/**
		* check if logged in or not
		* @return promise
		*
		*/
		isLoggedIn: function () {
			var self = this;
			return this.getSessionInfo().then(function (result) {
				if (self.shouldManageSessionId)
					cookies.set_sessionId(result.session_id);
				return !!(result.uid); 
			});
		},
		searchRead: function(model, domain, fields) {
			var params = {
				model: model,
				domain: domain,
				fields: fields
			}
			return this.sendRequest('/web/dataset/search_read', params);
		},
		getSessionInfo: function(model, method, args, kwargs) {
			return this.sendRequest('/web/session/get_session_info', {});
		},

		getServerInfo: function(model, method, args, kwargs) {
			return this.sendRequest('/web/webclient/version_info', {});
		},

		getDbList: function() {
			if (this.shouldUseJsonCall)
				return this.callJson('db','list',[]);
			else
				return this.sendRequest('/web/database/list', {});
		},
		callJson: function(service, method, args) {
			var params = {
				service: service,
				method: method,
				args: args,
			};
			return this.sendRequest('/jsonrpc', params);
		},
		call: function(model, method, args, kwargs) {

			kwargs = kwargs || {};
			kwargs.context = kwargs.context || {};
			Object.assign(kwargs.context, {'lang': 'fr_FR'});

			var params = {
				model: model,
				method: method,
				args: args,
				kwargs: kwargs,
			};
			return this.sendRequest('/web/dataset/call_kw', params);
		},
		/**
		* base function
		*/
		sendRequest: function(url, params) {
			console.log('send request', url, params);
			/** (internal) build request for $http
			* keep track of uniq_id_counter
			* add session_id in the request (for Odoo v7 only) 
			*/
			function buildRequest(url, params) {
				self.uniq_id_counter += 1;
				var headers = {
					'Content-Type': 'application/json',
				}

				if (self.shouldManageSessionId) {
					params.session_id = cookies.get_sessionId();
					headers['X-Openerp-Session-Id'] = cookies.get_sessionId()
				}
				var json_data = {
					jsonrpc: '2.0',
					method: 'call',
					params: params, //payload
				};
				return {
					'method' : 'POST',
					'url' : url,
					'body' : JSON.stringify(json_data),
					'headers': headers,
					'id': ("r" + self.uniq_id_counter),
				};
			}

			/** (internal) Odoo do some error handling and doesn't care
			* about HTTP response code
			* catch errors codes here and reject
			*	@param response $http promise
			*	@return promise 
			*		if no error : response.data ($http.config & header stripped)
			*		if error : reject with a custom errorObj
			*/
			function handleOdooErrors(response) {
				if (!response.error)
					return response;

				var error = response.error;
				var errorObj = {
					title: '',
					message:'',
					fullTrace: error
				};

				if (error.code === 200 && error.message === "Odoo Server Error" && error.data.name === "werkzeug.exceptions.NotFound") {
					errorObj.title = 'page_not_found';
					errorObj.message = 'HTTP Error';
				} else if ( (error.code === 100 && error.message === "Odoo Session Expired") || //v8
							(error.code === 300 && error.message === "OpenERP WebClient Error" && error.data.debug.match("SessionExpiredException")) //v7
						) {
							errorObj.title ='session_expired';
							cookies.delete_sessionId();
				} else if ( (error.message === "Odoo Server Error" && /FATAL:  database "(.+)" does not exist/.test(error.data.message))) {
					errorObj.title = "database_not_found";
					errorObj.message = error.data.message;
				} else if ( (error.data.name === "openerp.exceptions.AccessError")) {
					errorObj.title = 'AccessError';
					errorObj.message = error.data.message;
				} else {
					var split = ("" + error.data.fault_code).split('\n')[0].split(' -- ');
					if (split.length > 1) {
						error.type = split.shift();
						error.data.fault_code = error.data.fault_code.substr(error.type.length + 4);
					}

					if (error.code === 200 && error.type) {
						errorObj.title = error.type;
						errorObj.message = error.data.fault_code.replace(/\n/g, "<br />");
					} else {
						errorObj.title = error.message;
						errorObj.message = error.data.debug.replace(/\n/g, "<br />");
					}
				}
				self.errorInterceptors.forEach(function (i) {
					i(errorObj);
				});
				return Promise.reject(errorObj)
			}

			/**
			*	(internal)
			*	catch HTTP response code (not handled by Odoo ie Error 500, 404)
			*	@params $http rejected promise
 			*	@return promise
			*/
			function handleHttpErrors(reason) {
				var errorObj = {title:'http', fullTrace: reason, message:'HTTP Error'};
				self.errorInterceptors.forEach(function (i) {
					i(errorObj);
				});
				return Promise.reject(errorObj);
			}

			/**
			*	(internal) wrapper around $http for handling errors and build request
			*/
			function http(url, params) {
				var req = buildRequest(url, params);
				var headers = new ng.http.Headers(req.headers);
				var obj = {
					url: req.url,
					method: req.method,
					headers: headers,
					body: req.body
				}
				var request = new ng.http.Request(obj);
				return self.http.request(request)
					.toPromise().then(res => res.json())
					.then(handleOdooErrors, handleHttpErrors);
			}

			/** (internal) determine if session_id shoud be managed by this lib
			* more info: 
			*	in v7 session_id is returned by the server in the payload 
			*		and it should be added in each request's paylaod.
			*		it's 
			*
			*	in v8 session_id is set as a cookie by the server
			*		therefor the browser send it on each request automatically
			*   in v9 some api have changed, like db.get_list (see jsonCall)
			*
			*	in both case, we keep session_id as a cookie to be compliant with other odoo web clients 
			*
			*/
			function preflight() {
				//preflightPromise is a kind of cache and is set only if the request succeed
				return self.preflightPromise || http('/web/webclient/version_info', {}).then(function (reason) {
					self.shouldManageSessionId = (reason.result.server_serie < "8"); //server_serie is string like "7.01"
					self.shouldUseJsonCall = (reason.result.server_serie >= "9.0");
					self.preflightPromise = Promise.resolve(); //runonce
				});
			}

			var self = this;
			return preflight().then(function () {
				return http(url, params).then(function(response) {
					var subRequests = [];
					if (response.result.type === "ir.actions.act_proxy") {
						throw "port me !";
						angular.forEach(response.result.action_list, function(action) {
							subRequests.push(this.http.post(action['url'], action['params']).toPromise());
						});
						return Promise.all(subRequests);
					} else
						return response.result;
				});
			});
		},
	});
})(window.ak || (window.ak = {}));
console.log('voila ak', ak);
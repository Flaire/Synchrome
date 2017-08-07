const ws = require('ws');
const EventEmitter = require('events');

class Page {
	/**
	 * @param {object} pageObject
	 * @param {string} pageObject.devtoolsFrontendUrl
	 * @param {string} pageObject.id
	 * @param {string} pageObject.title
	 * @param {string} pageObject.type
	 * @param {string} pageObject.url
	 * @param {string} pageObject.webSocketDebuggerUrl
	 * @param {Browser} browser
	 */
	constructor(pageObject, browser) {
		this._id = pageObject.id;
		this._server = pageObject.webSocketDebuggerUrl;
		this._browser = browser;

		this._packetCounter = 0;
		this._packetCallbacks = new Map();

		this._eventEmitter = new EventEmitter();
		this._connect();

		this.send('Console.enable');
		this.send('Page.enable');
		this.listen('Console.messageAdded', ({message}) => message.text.split('\r\n').forEach(line => console.log('[' + message.source + ']', line)));
	}

	/**
	 * Get the id of the page
	 * @return {string}
	 */
	get id() {
		return this._id;
	}

	/**
	 * Get the browser hosting this page
	 * @return {Browser}
	 */
	get browser() {
		return this._browser;
	}

	/**
	 * Connect to the page
	 * @private
	 */
	_connect() {
		this._packetCallbacks.clear(); //todo reject all

		this._socket = new ws(this._server);

		this._socket.on('error', err => console.log('error', err));
		this._socket.on('message', message => this._onMessage(message));
	}

	/**
	 * Wait for the socket to connect
	 * @return {Promise}
	 * @private
	 */
	_waitForConnection() {
		return new Promise(resolve => {
			if (this._socket.readyState === 1)
				return resolve();

			this._socket.once('open', () => resolve());
		});
	}

	/**
	 * Handle JSON packets
	 * @param {string} message - JSON message
	 * @private
	 */
	_onMessage(message) {
		let json = JSON.parse(message);

		if ('id' in json && this._packetCallbacks.has(json.id)) {
			let callback = this._packetCallbacks.get(json.id);

			if ('error' in json) {
				console.error(json.error.code, json.error.message);
				callback.reject(json.error);
			} else callback.resolve(json.result);

			this._packetCallbacks.delete(json.id);
		} else if ('method' in json) {
			this._eventEmitter.emit(json.method, json.params);
		} else {
			console.warn('No action set for packet', json);
		}
	}

	/**
	 * Listen for event (like eventEmitter.addListener)
	 * @param {string} method - Method to listen to
	 * @param {Function} listener - Callback
	 */
	listen(method, listener) {
		this._eventEmitter.addListener(method, listener);
	}

	/**
	 * Listen for event only once (Like eventEmitter.once)
	 * @param method
	 * @return {Promise.<*>}
	 */
	wait(method) {
		return new Promise(resolve => this._eventEmitter.once(method, (...args) => resolve(...args)));
	}

	/**
	 * Send a event to the page
	 * @param {string} method - Method to send
	 * @param {object} [params] - Parameters
	 */
	send(method, params = {}) {
		return new Promise(async (resolve, reject) => {
			await this._waitForConnection();

			this._packetCounter++;
			this._packetCallbacks.set(this._packetCounter, {resolve: resolve, reject: reject});

			let json = JSON.stringify({
				id: this._packetCounter,
				method: method,
				params: params
			});

			this._socket.send(json);
		});
	}

	/**
	 * Navigate to url and optionally wait for it to load
	 * @param {string} url - Url to navigate to
	 * @param {boolean} waitForLoad - Wait for the page te load
	 * @return {Promise.<void>}
	 */
	async navigate(url, waitForLoad = true) {
		await this._page.send('Page.navigate', {url: url});

		if (waitForLoad === true)
			await this._page.wait('Page.loadEventFired');
	}

	/**
	 * Post data to a certain url
	 * @param {string} url
	 * @param {object} data
	 * @return {Promise.<void>}
	 */
	async post(url, data) {
		await this.execSync((url, data) => {
			let form = document.createElement('form');
			form.setAttribute('method', 'POST');
			form.setAttribute('action', url);

			for (let entry of Object.entries(data)) {
				let input = document.createElement('input');
				input.setAttribute('type', 'hidden');
				input.setAttribute('name', entry[0]);
				input.setAttribute('value', entry[1]);

				form.appendChild(input);
			}

			document.body.appendChild(form);
			form.submit();
		}, url, data);

		await this.wait('Page.loadEventFired');
	}

	/**
	 * Execute script and return the result
	 * @param {string} script - Script to execute
	 * @param {object} [options] - Optional options object
	 * @param {boolean} [options.promise] - Returned property is a promise
	 * @return {Promise.<*>}
	 */
	async exec(script, options = {}) {
		return this.send('Runtime.evaluate', {
			expression: script.toString(),
			userGesture: true,
			returnByValue: true,
			awaitPromise: options.promise === true
		}).then(result => new Promise((resolve, reject) => {
			if (result.exceptionDetails)
				return reject(result.exceptionDetails);

			resolve(result);
		}));
	}

	/**
	 * Execute script and return the result
	 * @param expression - Expression to execute
	 * @param {*} params - Arguments to pass to the function
	 * @return {Promise.<*>}
	 */
	execSync(expression, ...params) {
		let script = `if(typeof params === undefined) { let params; }
			params = ${JSON.stringify(params)};
			(${expression.toString()})(...params);`;

		return this.exec(script).then(data => data.result.value);
	}

	/**
	 * Execute script and return the result
	 * @param expression - Promise to execute
	 * @param {*} params - Arguments to pass to the function
	 * @return {Promise.<*>}
	 */
	execPromise(expression, ...params) {
		let script = `if(typeof params === undefined) { let params; }
			params = ${JSON.stringify(params)};
			(${expression.toString()})(...params);`;

		return this.exec(script, {promise: true}).then(data => data.result.value);
	}

	/**
	 * Wait for the expression to return true
	 * @param expression - Expression to execute
	 * @param {number} timeout - Timeout in ms
	 * @param {*} params - Arguments to pass to the function
	 * @return {Promise.<*>}
	 */
	async waitFor(expression, timeout = 10000, ...params) {
		let passes = timeout / 10;

		return new Promise((resolve, reject) => {
			let exec = () => this.execSync(expression, ...params).then(result => {
				if (result)
					return resolve(result);
				else if (passes <= 0)
					return reject('Timeout of ' + timeout + 'ms exceeded');

				setTimeout(exec, 10);
				passes--;
			}).catch(reject);

			exec();
		});
	}

	/**
	 * Close the page
	 * @return {Promise.<void>}
	 */
	close() {
		return this.browser.close(this);
	}
}

module.exports = Page;
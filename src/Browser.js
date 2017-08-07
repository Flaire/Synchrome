const childProcess = require('child_process');
const http = require('http');
const EventEmitter = require('events');
const Page = require('./Page');

class Browser {
	/**
	 * Create a new headless chrome instance and attach a debugger
	 * @param {object} [config={}]
	 * @param {string} [config.executable="google-chrome"]
	 * @param {number} [config.port=9222]
	 */
	constructor(config) {
		this._config = Object.assign({
			executable: 'google-chrome',
			port: 9222
		}, config);

		this._defaultPage = null;
		this._sockets = new Map();
		this._eventEmitter = new EventEmitter();

		this._initialized = false;
		this._initialize().then(() => {
			this._initialized = true;
			this._eventEmitter.emit('initialized');
		});

		this._eventEmitter.on('browser-exit', () => {
			this._initialized = false;

			this._initialize().then(() => {
				this._initialized = true;
				this._eventEmitter.emit('initialized');
			});
		});
	}

	/**
	 * Make sure everything is initialized.
	 * @return {Promise.<void>}
	 * @private
	 */
	async _waitForInit() {
		return new Promise(resolve => {
			if (this._initialized)
				resolve();
			else
				this._eventEmitter.once('initialized', () => resolve());
		});
	}

	/**
	 * (re-)start chrome process
	 * @return {Promise.<void>}
	 * @private
	 */
	async _refreshProcess() {
		let args = [];
		args.push(`--remote-debugging-port=${this._config.port}`);

		args.push('--headless'); // Use headless mode
		args.push('--no-sandbox'); // Sandbox doesn't work in Docker
		args.push('--disable-gpu'); // Disable GPU

		args.push('about:blank#default-page');

		this._process = childProcess.spawn(this._config.executable, args);

		this._process.stdout.pipe(process.stdout);
		this._process.stderr.pipe(process.stderr);

		this._process.on('error', error => console.error(error));
		this._process.on('exit', () => this._eventEmitter.emit('browser-exit'));

		return new Promise(resolve => {
			let retry = () => {
				let request = http.get(`http://localhost:${this._config.port}`, () => resolve());
				request.on('error', () => setTimeout(() => retry(), 5));
			};

			retry();
		});
	}

	/**
	 * Create a new page
	 * @param {string} [url]
	 * @return {Promise.<Page>}
	 */
	async open(url = 'about:blank') {
		await this._waitForInit();

		let response = await this._defaultPage.send('Target.createTarget', {url: url});
		let pages = await this.list();
		let page = pages.find(page => page.id === response.targetId); // We need to get the webSocketDebuggerUrl property so Target.getTargetInfo does not work

		return await this.get(page);
	}

	/**
	 * Close a page
	 * @param {Page} page
	 * @return {Promise.<void>}
	 */
	async close(page) {
		await this._waitForInit();

		return this._defaultPage.send('Target.closeTarget', {targetId: page.id});
	}

	/**
	 * Get a list of all pages
	 * @return {Promise<[{devtoolsFrontendUrl: string, id: string, title: string, type: string, url: string, webSocketDebuggerUrl: string}]>}
	 */
	async list() {
		return new Promise((resolve, reject) => {
			http.get('http://localhost:' + this._config.port + '/json', (res) => {
				let buffers = [];
				res.on('data', data => buffers.push(data));
				res.on('end', () => {
					let buffer = Buffer.concat(buffers);
					let string = buffer.toString();
					let json = JSON.parse(string);

					resolve(json);
				});
			}).on('error', error => reject(error));
		});
	}

	/**
	 * @param {object} target
	 * @param {string} target.devtoolsFrontendUrl
	 * @param {string} target.id
	 * @param {string} target.title
	 * @param {string} target.type
	 * @param {string} target.url
	 * @param {string} target.webSocketDebuggerUrl
	 */
	get (target) {
		let page;

		if (this._sockets.has(target.id))
			page = this._sockets.get(target.id);
		else
			page = new Page(target, this);

		this._sockets.set(target.id, page);
		return page;
	}

	/**
	 * @private
	 */
	async _initialize() {
		await this._refreshProcess();
		let pages = await this.list();

		this._defaultPage = this.get(pages.find(page => page.url === 'about:blank#default-page') || pages[0]);
		this._defaultPage.send('Target.setDiscoverTargets', {discover: true});
	}
}

module.exports = Browser;
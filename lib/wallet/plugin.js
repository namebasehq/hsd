/*!
 * plugin.js - wallet plugin for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const EventEmitter = require('events');
const WalletDB = require('./walletdb');
const NodeClient = require('./nodeclient');
const HTTP = require('./http');
const RPC = require('./rpc');

// TODO Remove me
const assert = require('bsert');

/**
 * @exports wallet/plugin
 */

const plugin = exports;

/**
 * Plugin
 * @extends EventEmitter
 */

class Plugin extends EventEmitter {
  /**
   * Create a plugin.
   * @constructor
   * @param {Node} node
   */

  constructor(node, options) {
    super();

    this.config = node.config.filter('wallet');
    this.config.inject(options);
    this.config.open('hsw.conf');

    this.network = node.network;
    this.logger = node.logger;

    this.client = new NodeClient(node);

    this.wdb = new WalletDB({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      client: this.client,
      prefix: this.config.prefix,
      memory: this.config.bool('memory', node.memory),
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      wipeNoReally: this.config.bool('wipe-no-really'),
      spv: node.spv,
      migrate: this.config.uint('migrate')
    });

    this.rpc = new RPC(this);

    this.http = new HTTP({
      network: this.network,
      logger: this.logger,
      node: this,
      ssl: this.config.bool('ssl'),
      keyFile: this.config.path('ssl-key'),
      certFile: this.config.path('ssl-cert'),
      host: this.config.str('http-host'),
      port: this.config.uint('http-port'),
      apiKey: this.config.str('api-key', node.config.str('api-key')),
      walletAuth: this.config.bool('wallet-auth'),
      noAuth: this.config.bool('no-auth'),
      cors: this.config.bool('cors'),
      adminToken: this.config.str('admin-token')
    });

    // Register Additional endpoints
    const context = {};
    this.http.registerRoute('post','/wallet/:id/batch/open',
      this.handleBatchOpen,
      context);

    this.init();
  }

  async handleBatchOpen(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions,Validator,network} = context;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const force = valid.bool('force', false);
    const passphrase = valid.str('passphrase');
    const broadcast = valid.bool('broadcast', true);
    const sign = valid.bool('sign', true);
    const MAX_NAME_ARRAY_LENGTH = 200;

    assert(names && names.length > 0, 'Names are required.');
    assert(names.length <= MAX_NAME_ARRAY_LENGTH,
      `Names array shoud not exceed ${MAX_NAME_ARRAY_LENGTH}`);
    assert(broadcast ? sign : true, 'Must sign when broadcasting.');

    const options = TransactionOptions.fromValidator(valid);
    const {mtx, errors, isAllError} = await req.wallet
                                      .createBatchOpen(names, force, options);

    if (isAllError) // no valid output in mtx
      return res.json(500, {errors: errors});

    if (broadcast) {
      const tx = await req.wallet.sendMTX(mtx, passphrase);
      return res.json(200, {tx: tx.getJSON(network), errors: errors});
    }

    if (sign) {
      await req.wallet.sign(mtx, passphrase);
    }

    return res.json(200, {tx: mtx.getJSON(network), errors: errors});
  }

  init() {
    this.wdb.on('error', err => this.emit('error', err));
    this.http.on('error', err => this.emit('error', err));
  }

  async open() {
    await this.wdb.open();
    this.rpc.wallet = this.wdb.primary;
    await this.http.open();
  }

  async close() {
    await this.http.close();
    this.rpc.wallet = null;
    await this.wdb.close();
  }
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = 'walletdb';

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {WalletDB}
 */

plugin.init = function init(node, options = {}) {
  return new Plugin(node, options);
};

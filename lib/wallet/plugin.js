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

    this.http.registerRoute('post', '/wallet/:id/batch/reveal',
      this.handleBatchReveal,
      context);

    this.http.registerRoute('post', '/wallet/:id/batch/revealwithcache',
      this.handleBatchRevealWithCache,
      context);

    this.http.registerRoute('post', '/wallet/:id/batch/bid',
      this.handleBatchBid,
      context);

    this.http.registerRoute('post', '/wallet/:id/batch/finish',
      this.handleBatchFinish,
      context);

    this.init();
  }

  async handleBatchOpen(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions, Validator,
      network, assert} = context;

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

  async handleBatchReveal(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions, Validator,
      network, assert} = context;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const passphrase = valid.str('passphrase');
    const broadcast = valid.bool('broadcast', true);
    const sign = valid.bool('sign', true);

    assert(names && names.length > 0, 'Names are required.');
    assert(broadcast ? sign : true, 'Must sign when broadcasting.');

    const options = TransactionOptions.fromValidator(valid);
    const {mtx, errorMessages} = await req.wallet
      .createBatchReveal(names, options);

    if (broadcast) {
      const tx = await req.wallet.sendMTX(mtx, passphrase);
      return res.json(200, {tx: tx.getJSON(network),
        errors: errorMessages});
    }

    if (sign)
      await req.wallet.sign(mtx, passphrase);

    return res.json(200, {tx: mtx.getJSON(network),
      errorMessages: errorMessages});
  }

  async handleBatchRevealWithCache(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions, Validator,
      network, assert, util, rules} = context;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const passphrase = valid.str('passphrase');

    assert(names && names.length > 0, 'Names are required.');
    const options = TransactionOptions.fromValidator(valid);

    const revealCache = req.wallet.sendRevealResults;

    const { cacheMisses: uniqueNames, cacheHits: processedReveals } = util
      .retrieveMultipleFromCache(revealCache, names);

    if (uniqueNames.length === 0) {
      return res.json(200, {processedReveals, errors: []});
    }

    const batchRevealResponse = await req.wallet
      .createBatchReveal(uniqueNames, options);

    const mtx = batchRevealResponse.mtx;
    const errorMessages = batchRevealResponse.errorMessages;

    // always broadcast
    const tx = await req.wallet.sendMTX(mtx, passphrase);
    const txJSON = tx.getJSON(network);

    const nameHashMap = new Map();
    for (const name of uniqueNames) {
      // to prevent a weird case of numerics (0)
      const nameHash = rules.hashName(String(name)).toString('hex');
      nameHashMap.set(nameHash, name);
    }

    const {outputs, hash: txHash} = txJSON;

    outputs.forEach((output, index) => {
      if (output.covenant.type === rules.types.REVEAL) {
        const nameHash = output.covenant.items[0];
        const name = nameHashMap.get(nameHash);
        const processedReveal = util
          .postProcessOutput(output, index, txHash, name);
        processedReveals.push(processedReveal);
        util.storeMultipleInCache(processedReveal, revealCache);
      }
    });

    return res.json(200, {processedReveals, errors: errorMessages});
  }

  async handleBatchBid(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions, Validator,
      network, assert, util} = context;

      const MAX_BIDS_ARRAY_LENGTH = 200;
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');

      if (!valid.has('bids'))
        throw new Error('Mandatory Bids parameter is missing!');

      let bids = valid.array('bids');
      assert(bids.length > 0 && bids.length <= MAX_BIDS_ARRAY_LENGTH,
        `Bids are required to be non empty and shoud not exceed
        ${MAX_BIDS_ARRAY_LENGTH}`);

      bids.forEach((element) => {
        const validator = new Validator(element);
        if (!validator.has('name') ||
            !validator.has('bid')  ||
            !validator.has('lockup') ||
            !validator.has('idempotencyKey')) {
          throw new Error('Bids contains a Bid with missing mandatory fields!');
        } else { // check types
          validator.str('name');
          validator.u64('bid');
          validator.u64('lockup');
          validator.str('idempotencyKey');
        }
      });

     // add value property (same as bid) to each bid
     // value property is same with bid property and used internally
      bids = bids.map((element) => {
        element['value'] = element.bid;
        return element;
      });

      const options = TransactionOptions.fromValidator(valid);

      const uniqueBids = [];
      const bidResults = [];

      let errors  = [];

      const bidCache = req.wallet.sendBidResults;

      for (const bid of bids) {
        const bidResultFromCache = bidCache.get(bid.idempotencyKey);
        if (bidResultFromCache)
          bidResults.push(bidResultFromCache);
        else
          uniqueBids.push(bid);
      }

      if (uniqueBids.length > 0) {
        const {mtx, errorMessages} = await req.wallet
          .createBatchBid(uniqueBids, options);

        errors = errorMessages;

        // always broadcast and sign
        const tx = await req.wallet.sendMTX(mtx, passphrase);
        const txJSON = tx.getJSON(network);

        const processedBids = util
          .postProcessBatchBids(txJSON.hash, txJSON.outputs, mtx.outputs);

        // update cache
        processedBids.forEach((bid) => {
          const cachedBid = Object.assign({}, bid);
          cachedBid.fromCache = true;
          bidCache.set(bid.idempotency_key, cachedBid);
        });

        processedBids.forEach(bid => bidResults.push(bid));
      }

      return res.json(200, {
        processedBids: bidResults,
        errorMessages: errors
      });
  }

  async handleBatchFinish(req, res, context) {
    // Load Helper classes from context
    const {TransactionOptions, Validator,
      network, assert, util, Resource, rules} = context;

    const valid = Validator.fromRequest(req);
    const finishRequests = valid.array('finishRequests');
    const passphrase = valid.str('passphrase');

    assert(finishRequests && finishRequests.length > 0,
      'FinishRequests are required.');

    finishRequests.forEach((element) => {
      const validator = new Validator(element);
      if (!validator.has('name') || !validator.has('data'))
        throw new Error('name and data must be present in every element.');

      validator.str('name');
      validator.obj('data');

      const dataValidator = new Validator(element.data);
      dataValidator.array('records');
    });

    const formattedFinishRequests = finishRequests.map(({name, data}) => {
      return {name, data: Resource.fromJSON(data)};
    });

    const options = TransactionOptions.fromValidator(valid);
    const finishCache = req.wallet.sendFinishResults;

    const uniqueNames = [];
    const processedFinishes = [];

    formattedFinishRequests.forEach(({name, data}) => {
      const cachedResponse = finishCache.get(name);
      if (!cachedResponse) {
        uniqueNames.push({name, data});
      } else {
        cachedResponse.forEach(cachedName =>
          processedFinishes.push(cachedName));
      }
    });

    let errorMessages = [];
    if (uniqueNames.length > 0) {
      const nameHashMap = new Map();
      uniqueNames.forEach(({name, data}) => {
        const nameHash = rules.hashName(name).toString('hex');
        nameHashMap.set(nameHash, name);
      });

    // always broadcast
      const finishResponse = await req.wallet.createBatchFinish(
        uniqueNames,
        options
      );
      errorMessages = finishResponse.errorMessages;

      const tx = await req.wallet.sendMTX(finishResponse.mtx, passphrase);
      const txJSON = tx.getJSON(network);

      util.postProcessBatchFinishes(
        txJSON,
        finishCache,
        nameHashMap,
        processedFinishes
      );
    }

    return res.json(200, {
      processedFinishes,
      errorMessages
    });
  };

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

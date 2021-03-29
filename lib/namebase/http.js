'use strict';

const assert = require('bsert');
const { BufferSet } = require('buffer-map');
const Address = require('../primitives/address');
const Output = require('../primitives/output');
const {Resource} = require('../dns/resource');
const rules = require('../covenants/rules');
const util = require('../utils/util');

module.exports = {

  // Batch Ops

  async handleBatchOpen(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions,
      Validator,
      network
    } = context;

    const MAX_NAME_ARRAY_LENGTH = 200;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const force = valid.bool('force', false);
    const passphrase = valid.str('passphrase');

    assert(names && names.length > 0, 'Names are required.');
    assert(
      names.length <= MAX_NAME_ARRAY_LENGTH,
      `Names array shoud not exceed ${MAX_NAME_ARRAY_LENGTH}`
    );

    const options = TransactionOptions.fromValidator(valid);
    const { mtx, errors, isAllError } = await req.wallet.createBatchOpen(
      names,
      force,
      options
    );

    if (isAllError) {
      // no valid output in mtx
      return res.json(500, { errors });
    }

    // always broadcast
    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, { tx: tx.getJSON(network), errors });
  },

  async handleBatchReveal(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions,
      Validator,
      network
    } = context;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const passphrase = valid.str('passphrase');

    assert(names && names.length > 0, 'Names are required.');

    const options = TransactionOptions.fromValidator(valid);
    const { mtx, errorMessages } = await req.wallet
      .createBatchReveal(names, options);

    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, {
      tx: tx.getJSON(network),
      errors: errorMessages
    });
  },

  async handleBatchRevealWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator,network
    } = context;

    const valid = Validator.fromRequest(req);
    const names = valid.array('names');
    const passphrase = valid.str('passphrase');

    assert(names && names.length > 0, 'Names are required.');
    const options = TransactionOptions.fromValidator(valid);

    const revealCache = req.wallet.sendRevealResults;
    const { cacheMisses: uniqueNames, cacheHits: processedReveals } = util
      .retrieveMultipleFromCache(revealCache, names);

    if (uniqueNames.length === 0) {
      return res.json(200, { processedReveals, errors: [] });
    }

    const batchRevealResponse = await req.wallet
      .createBatchReveal(uniqueNames, options);

    const { mtx } = batchRevealResponse;
    const { errorMessages } = batchRevealResponse;

    // always broadcast
    const tx = await req.wallet.sendMTX(mtx, passphrase);
    const txJSON = tx.getJSON(network);

    const nameHashMap = new Map();
    uniqueNames.forEach((name) => {
      // to prevent a weird case of numerics (0)
      const nameHash = rules.hashName(String(name)).toString('hex');
      nameHashMap.set(nameHash, name);
    });

    const { outputs, hash: txHash } = txJSON;

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

    return res.json(200, { processedReveals, errors: errorMessages });
  },

  async handleBatchBid(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator,network
    } = context;

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
      if (!validator.has('name')
            || !validator.has('bid')
            || !validator.has('lockup')
            || !validator.has('idempotencyKey')) {
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
      element.value = element.bid;
      return element;
    });

    const options = TransactionOptions.fromValidator(valid);

    const uniqueBids = [];
    const bidResults = [];

    let errors = [];

    const bidCache = req.wallet.sendBidResults;

    bids.forEach((bid) => {
      const bidResultFromCache = bidCache.get(bid.idempotencyKey);
      if (bidResultFromCache) {
        bidResults.push(bidResultFromCache);
      } else {
        uniqueBids.push(bid);
      }
    });

    if (uniqueBids.length > 0) {
      const { mtx, errorMessages } = await req.wallet
        .createBatchBid(uniqueBids, options);

      errors = errorMessages;

      // always broadcast and sign
      const tx = await req.wallet.sendMTX(mtx, passphrase);
      const txJSON = tx.getJSON(network);

      const processedBids = util
        .postProcessBatchBids(txJSON.hash, txJSON.outputs, mtx.outputs);

      // update cache
      processedBids.forEach((bid) => {
        const cachedBid = { ...bid };
        cachedBid.fromCache = true;
        bidCache.set(bid.idempotency_key, cachedBid);
      });

      processedBids.forEach(bid => bidResults.push(bid));
    }

    return res.json(200, {
      processedBids: bidResults,
      errorMessages: errors
    });
  },

  async handleBatchFinish(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator,network
    } = context;

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

    const formattedFinishRequests = finishRequests
      .map(({ name, data }) => ({ name, data: Resource.fromJSON(data) }));

    const options = TransactionOptions.fromValidator(valid);

    const uniqueNames = [];
    const processedFinishes = [];

    const finishCache = req.wallet.sendFinishResults;

    formattedFinishRequests.forEach(({ name, data }) => {
      const cachedResponse = finishCache.get(name);
      if (!cachedResponse) {
        uniqueNames.push({ name, data });
      } else {
        cachedResponse.forEach(cachedName =>
          processedFinishes.push(cachedName));
      }
    });

    let errorMessages = [];
    if (uniqueNames.length > 0) {
      const nameHashMap = new Map();
      uniqueNames.forEach(({ name }) => {
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
  },

  // Auction Ops - Requires cache refactor

  async handleOpenWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator, network
    } = context;

    const valid = Validator.fromRequest(req);
    const name = valid.str('name');
    const force = valid.bool('force', false);
    const passphrase = valid.str('passphrase');
    const idempotencyKey = valid.str('idempotencyKey');

    assert(name, 'Name is required.');
    assert(idempotencyKey, 'IdempotencyKey is required.');

    const options = TransactionOptions.fromValidator(valid);

    const {result, fromCache} = await req.wallet.withOpenCache(
      idempotencyKey,
      () => {
        return req.wallet.createOpen(name, force, options);
      }
    );

    const mtx = result;
    res.setHeader('From-Cache', fromCache);

    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, tx.getJSON(network));
  },

  async handleBidWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator
    } = context;

    const valid = Validator.fromRequest(req);
    const name = valid.str('name');
    const bid = valid.u64('bid');
    const lockup = valid.u64('lockup');
    const passphrase = valid.str('passphrase');
    const broadcast = valid.bool('broadcast', true);
    const sign = valid.bool('sign', true);
    const idempotencyKey = valid.str('idempotencyKey');

    assert(name, 'Name is required.');
    assert(bid != null, 'Bid is required.');
    assert(lockup != null, 'Lockup is required.');
    assert(broadcast ? sign : true, 'Must sign when broadcasting.');
    if (idempotencyKey) {
      assert(
        broadcast && sign,
        'Must sign and broadcast if using idempotency cache'
      );
    }

    const options = TransactionOptions.fromValidator(valid);

    const {result, fromCache} = await req.wallet.withBidCache(
      idempotencyKey,
      () => {
        return req.wallet.createBid(name, bid, lockup, options);
      }
    );
    const mtx = result;
    res.setHeader('From-Cache', fromCache);

    if (broadcast) {
      const tx = await req.wallet.sendMTX(mtx, passphrase);
      return res.json(200, tx.getJSON(this.network));
    }

    if (sign)
      await req.wallet.sign(mtx, passphrase);

    return res.json(200, mtx.getJSON(this.network));
  },

  async handleUpdateWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator
    } = context;

    const valid = Validator.fromRequest(req);
    const name = valid.str('name');
    const data = valid.obj('data');
    const passphrase = valid.str('passphrase');
    const idempotencyKey = valid.str('idempotencyKey');

    assert(name, 'Must pass name.');
    assert(data, 'Must pass data.');
    assert(idempotencyKey, 'IdempotencyKey is required.');

    let resource;
    try {
      resource = Resource.fromJSON(data);
    } catch (e) {
      return res.json(400);
    }

    const options = TransactionOptions.fromValidator(valid);

    const {result, fromCache} = await req.wallet.withUpdateCache(
      idempotencyKey,
      () => {
        return req.wallet.createUpdate(name, resource, options);
      }
    );
    const mtx = result;
    res.setHeader('From-Cache', fromCache);

    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, tx.getJSON(this.network));
  },

  async handleTransferWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator
    } = context;

    const valid = Validator.fromRequest(req);
    const name = valid.str('name');
    const address = valid.str('address');
    const passphrase = valid.str('passphrase');
    const idempotencyKey = valid.str('idempotencyKey');

    assert(name, 'Must pass name.');
    assert(address, 'Must pass address.');
    assert(idempotencyKey, 'IdempotencyKey is required.');

    const addr = Address.fromString(address, this.network);
    const options = TransactionOptions.fromValidator(valid);
    const {result, fromCache} = await req.wallet.withTransferCache(
      idempotencyKey,
      () => {
        return req.wallet.createTransfer(name, addr, options);
      }
    );
    const mtx = result;
    res.setHeader('From-Cache', fromCache);

    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, tx.getJSON(this.network));
  },

  async handleFinalizeWithCache(req, res, context) {
    // Load Helper classes from context
    const {
      TransactionOptions, Validator
    } = context;

    const valid = Validator.fromRequest(req);
    const name = valid.str('name');
    const passphrase = valid.str('passphrase');
    const idempotencyKey = valid.str('idempotencyKey');

    assert(name, 'Must pass name.');
    assert(idempotencyKey, 'IdempotencyKey is required.');

    const options = TransactionOptions.fromValidator(valid);
    const {result, fromCache} = await req.wallet.withFinalizeCache(
      idempotencyKey,
      () => {
        return req.wallet.createFinalize(name, options);
      }
    );
    const mtx = result;
    res.setHeader('From-Cache', fromCache);

    const tx = await req.wallet.sendMTX(mtx, passphrase);
    return res.json(200, tx.getJSON(this.network));
  },

  // SendMany
  async handleSendMany(req, res, context) {
    // Load Helper classes from context
    const { Validator, network } = context;

    const valid = Validator.fromRequest(req);
    const account = valid.str('account', 'default');
    const sendTo = valid.array('sendto', []);
    const minconf = valid.u32('minconf', 1);
    const subtractFee = valid.bool('subtractfee', false);
    const passphrase = valid.str('passphrase');

    if (sendTo.length === 0)
      throw new Error('parameter sendto is required and can not be empty!');

    const results = [];

    const hsdTransferCache = req.wallet.hsdTransferResults;
    for (const { idempotency_key: idempotencyKey } of sendTo) {
      if (idempotencyKey && hsdTransferCache.has(idempotencyKey)) {
        results.push(hsdTransferCache.get(idempotencyKey));
      }
    }

    const filteredSendTo = sendTo.filter(element =>
      !hsdTransferCache.has(element.idempotency_key));

    const addressToIdempotencyKeyMap = new Map();
    const uniq = new BufferSet();

    const outputs = filteredSendTo.map((element) => {
      const to = new Validator(element);

      const idempotencyKey = to.str('idempotency_key');
      if (!idempotencyKey)
        throw new Error('idempotencyKey is missing!');

      const value = to.u64('value');
      if (!value)
        throw new Error(`value: ${value} is invalid!`);

      const rawAddress = to.str('address');

      const parseAddress = (raw, network) => {
        try {
              return Address.fromString(raw, network);
            } catch (e) {
              throw new Error(`${raw} Invalid address.`);
          }
      };

      const addr = parseAddress(rawAddress, network);
      addressToIdempotencyKeyMap.set(addr.toString(), {
        idempotencyKey,
        rawAddress
      });

      const hash = addr.getHash();

      if (uniq.has(hash))
        throw new Error('Invalid parameter!');

      uniq.add(hash);

      const output = new Output();
      output.value = value;
      output.address = addr;

      return output;
    });

    if (outputs.length > 0) {
      const options = {
        outputs,
        subtractFee,
        account,
        depth: minconf
      };

      const tx = await req.wallet.send(options, passphrase);

      const txJSON = tx.toJSON();
      const txOutputsLen = txJSON.outputs.length;

      for (let i = 0; i < txOutputsLen; i += 1) {
        const output = txJSON.outputs[i];
        if (addressToIdempotencyKeyMap.has(output.address)) {
          const { idempotencyKey } = addressToIdempotencyKeyMap
            .get(output.address);

          const hsdTransfer = {
            idempotency_key: idempotencyKey,
            tx_hash: txJSON.hash,
            output_index: i,
            output
          };

          results.push(hsdTransfer);

          const cachedHsdTransfer = { ...hsdTransfer };
          cachedHsdTransfer.fromCache = true;
          hsdTransferCache.set(cachedHsdTransfer.idempotency_key,
            cachedHsdTransfer);
        }
      }
    }

    return res.json(200, { processedWithdrawals: results });
  },

  // Cache Ops
  async handleClearCache(req, res, context) {
    const {walletDB} = context;
    const cacheName = req.params.cacheName;
    try {
      for (const wallet of walletDB.wallets.values()) {
        wallet.clearCache(cacheName);
      }
    } catch (err) {
      return res.json(400, {error: err.message});
    }

    return res.json(200, {message: 'ok'});
  },

  async handleClearKeyFromCache(req, res, context) {
    const {walletDB} = context;
    const cacheName = req.params.cacheName;
    const cacheKey = req.params.cacheKey;

    try {
      for (const wallet of walletDB.wallets.values()) {
        wallet.clearCache(cacheName, cacheKey);
      }
    } catch (err) {
      return res.json(400, {error: err.message});
    }

    return res.json(200, {message: 'ok'});
  }

};

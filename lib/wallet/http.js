/*!
 * http.js - wallet http server for hsd
 * Copyright (c) 2017-2019, Christopher Jeffrey (MIT License).
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const path = require('path');
const { Server } = require('bweb');
const Route = require('bweb/lib/route');
const Validator = require('bval');
const base58 = require('bcrypto/lib/encoding/base58');
const MTX = require('../primitives/mtx');
const Outpoint = require('../primitives/outpoint');
const sha256 = require('bcrypto/lib/sha256');
const rules = require('../covenants/rules');
const random = require('bcrypto/lib/random');
const Covenant = require('../primitives/covenant');
const { safeEqual } = require('bcrypto/lib/safe');
const Network = require('../protocol/network');
const Address = require('../primitives/address');
const KeyRing = require('../primitives/keyring');
const Mnemonic = require('../hd/mnemonic');
const HDPrivateKey = require('../hd/private');
const HDPublicKey = require('../hd/public');
const { Resource } = require('../dns/resource');
const common = require('./common');
const { nextTick } = require('process');

/** @typedef {import('../protocol/network')} Network */
/** @typedef {import('./walletdb')} WalletDB */
/** @typedef {import('./rpc')} RPC */

/**
 * HTTP
 * @alias module:wallet.HTTP
 */

class HTTP extends Server {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new HTTPOptions(options));

    /** @type {Network} */
    this.network = this.options.network;
    this.logger = this.options.logger.context('wallet-http');
    /** @type {WalletDB} */
    this.wdb = this.options.node.wdb;
    /** @type {RPC} */
    this.rpc = this.options.node.rpc;

    this.init();
  }

  /**
   * Initialize http server.
   * @private
   */

  init() {
    this.on('request', (req, res) => {
      if (req.method === 'POST' && req.pathname === '/')
        return;

      this.logger.debug('Request for method=%s path=%s (%s).',
        req.method, req.pathname, req.socket.remoteAddress);
    });

    this.on('listening', (address) => {
      this.logger.info('Wallet HTTP server listening on %s (port=%d).',
        address.address, address.port);
    });

    this.initRouter();
    this.initSockets();
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    // TODO: This needs to go to the bweb using proper
    // shim for the EventTarget/Event and AbortController/Signal.
    // This can potentially allow us to even Abort coin selection.
    this.use(async (req, res) => {
      res.signal = {
        get aborted() {
          return res.closed;
        }
      };
    });

    if (this.options.cors)
      this.use(this.cors());

    if (!this.options.noAuth) {
      this.use(this.basicAuth({
        hash: sha256.digest,
        password: this.options.apiKey,
        realm: 'wallet'
      }));
    }

    this.use(this.bodyParser({
      type: 'json'
    }));

    this.use(async (req, res) => {
      if (!this.options.walletAuth) {
        req.admin = true;
        return;
      }

      const valid = Validator.fromRequest(req);
      const token = valid.buf('token');

      if (token && safeEqual(token, this.options.adminToken)) {
        req.admin = true;
        return;
      }

      if (req.method === 'POST' && req.path.length === 0) {
        res.json(403);
        return;
      }
    });

    this.use(this.jsonRPC());
    this.use(this.router());

    this.error((err, req, res) => {
      if (!err.statusCode && err.type === 'ABORT')
        err.statusCode = 408;

      const code = err.statusCode || 500;
      res.json(code, {
        error: {
          type: err.type,
          code: err.code,
          message: err.message
        }
      });
    });

    this.hook(async (req, res) => {
      if (req.path.length < 2)
        return;

      if (req.path[0] !== 'wallet')
        return;

      if (req.method === 'PUT' && req.path.length === 2)
        return;

      const valid = Validator.fromRequest(req);
      const id = valid.str('id');
      const token = valid.buf('token');

      if (!id) {
        res.json(403);
        return;
      }

      if (req.admin || !this.options.walletAuth) {
        const wallet = await this.wdb.get(id);

        if (!wallet) {
          res.json(404);
          return;
        }

        req.wallet = wallet;

        return;
      }

      if (!token) {
        res.json(403);
        return;
      }

      let wallet;
      try {
        wallet = await this.wdb.auth(id, token);
      } catch (err) {
        this.logger.info('Auth failure for %s: %s.', id, err.message);
        res.json(403);
        return;
      }

      if (!wallet) {
        res.json(404);
        return;
      }

      req.wallet = wallet;

      this.logger.info('Successful auth for %s.', id);
    });

    // Rescan
    this.post('/rescan', async (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      const valid = Validator.fromRequest(req);
      const height = valid.u32('height');

      res.json(200, { success: true });

      await this.wdb.rescan(height);
    });

    // Deep Clean
    this.post('/deepclean', async (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      const valid = Validator.fromRequest(req);
      const disclaimer = valid.bool('I_HAVE_BACKED_UP_MY_WALLET', false);

      enforce(
        disclaimer,
        'Deep Clean requires I_HAVE_BACKED_UP_MY_WALLET=true'
      );

      res.json(200, { success: true });

      await this.wdb.deepClean();
    });

    // Resend
    this.post('/resend', async (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      await this.wdb.resend();

      res.json(200, { success: true });
    });

    // Backup WalletDB
    this.post('/backup', async (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      const valid = Validator.fromRequest(req);
      const path = valid.str('path');

      enforce(path, 'Path is required.');

      await this.wdb.backup(path);

      res.json(200, { success: true });
    });

    // List wallets
    this.get('/wallet', async (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      const wallets = await this.wdb.getWallets();
      res.json(200, wallets);
    });

    // Get wallet
    this.get('/wallet/:id', async (req, res) => {
      const balance = await req.wallet.getBalance();
      res.json(200, req.wallet.getJSON(false, balance));
    });

    // Get wallet master key
    this.get('/wallet/:id/master', (req, res) => {
      if (!req.admin) {
        res.json(403);
        return;
      }

      res.json(200, req.wallet.master.getJSON(this.network, true));
    });

    // Create wallet
    this.put('/wallet/:id', async (req, res) => {
      const valid = Validator.fromRequest(req);

      let master = valid.str('master');
      let mnemonic = valid.str('mnemonic');
      let accountKey = valid.str('accountKey');

      if (master)
        master = HDPrivateKey.fromBase58(master, this.network);

      if (mnemonic)
        mnemonic = Mnemonic.fromPhrase(mnemonic);

      if (accountKey)
        accountKey = HDPublicKey.fromBase58(accountKey, this.network);

      const wallet = await this.wdb.create({
        id: valid.str('id'),
        type: valid.str('type'),
        m: valid.u32('m'),
        n: valid.u32('n'),
        passphrase: valid.str('passphrase'),
        master: master,
        mnemonic: mnemonic,
        accountKey: accountKey,
        watchOnly: valid.bool('watchOnly'),
        lookahead: valid.u32('lookahead'),
        staticAddress: valid.bool('staticAddress')
      });

      const balance = await wallet.getBalance();

      res.json(200, wallet.getJSON(false, balance));
    });

    // List accounts
    this.get('/wallet/:id/account', async (req, res) => {
      const accounts = await req.wallet.getAccounts();
      res.json(200, accounts);
    });

    // Get account
    this.get('/wallet/:id/account/:account', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const account = await req.wallet.getAccount(acct);

      if (!account) {
        res.json(404);
        return;
      }

      const balance = await req.wallet.getBalance(account.accountIndex);

      res.json(200, account.getJSON(balance));
    });

    // Create account
    this.put('/wallet/:id/account/:account', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');

      let accountKey = valid.get('accountKey');

      if (accountKey)
        accountKey = HDPublicKey.fromBase58(accountKey, this.network);

      const options = {
        name: valid.str('account'),
        watchOnly: valid.bool('watchOnly'),
        type: valid.str('type'),
        m: valid.u32('m'),
        n: valid.u32('n'),
        accountKey: accountKey,
        lookahead: valid.u32('lookahead'),
        staticAddress: valid.bool('staticAddress')
      };

      const account = await req.wallet.createAccount(options, passphrase);
      const balance = await req.wallet.getBalance(account.accountIndex);

      res.json(200, account.getJSON(balance));
    });

    // Change passphrase
    this.post('/wallet/:id/passphrase', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');
      const old = valid.str('old');

      enforce(passphrase, 'Passphrase is required.');

      await req.wallet.setPassphrase(passphrase, old);

      res.json(200, { success: true });
    });

    // Unlock wallet
    this.post('/wallet/:id/unlock', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');
      const timeout = valid.u32('timeout');

      enforce(passphrase, 'Passphrase is required.');

      await req.wallet.unlock(passphrase, timeout);

      res.json(200, { success: true });
    });

    // Lock wallet
    this.post('/wallet/:id/lock', async (req, res) => {
      await req.wallet.lock();
      res.json(200, { success: true });
    });

    // Import key
    this.post('/wallet/:id/import', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const passphrase = valid.str('passphrase');
      const pub = valid.buf('publicKey');
      const priv = valid.str('privateKey');
      const b58 = valid.str('address');

      if (pub) {
        const key = KeyRing.fromPublic(pub);
        await req.wallet.importKey(acct, key);
        res.json(200, { success: true });
        return;
      }

      if (priv) {
        const key = KeyRing.fromSecret(priv, this.network);
        await req.wallet.importKey(acct, key, passphrase);
        res.json(200, { success: true });
        return;
      }

      if (b58) {
        const addr = Address.fromString(b58, this.network);
        await req.wallet.importAddress(acct, addr);
        res.json(200, { success: true });
        return;
      }

      enforce(false, 'Key or address is required.');
    });

    // Generate new token
    this.post('/wallet/:id/retoken', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');
      const token = await req.wallet.retoken(passphrase);

      res.json(200, {
        token: token.toString('hex')
      });
    });

    // Send TX
    this.post('/wallet/:id/send', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const options = TransactionOptions.fromValidator(valid, res.signal);
      const tx = await req.wallet.send(options);

      const details = await req.wallet.getDetails(tx.hash());
      res.json(200, details.getJSON(this.network, this.wdb.height));
    });

    // Create TX
    this.post('/wallet/:id/create', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');
      const sign = valid.bool('sign', true);

      const options = TransactionOptions.fromValidator(valid, res.signal);
      const tx = await req.wallet.createTX(options);

      if (sign)
        await req.wallet.sign(tx, passphrase);

      res.json(200, tx.getJSON(this.network));
    });

    // Sign TX
    this.post('/wallet/:id/sign', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const passphrase = valid.str('passphrase');
      const raw = valid.buf('tx');

      enforce(raw, 'TX is required.');

      const tx = MTX.decode(raw);
      tx.view = await req.wallet.getCoinView(tx);

      await req.wallet.sign(tx, passphrase);

      res.json(200, tx.getJSON(this.network));
    });

    // Zap Wallet TXs
    this.post('/wallet/:id/zap', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const age = valid.u32('age');

      enforce(age, 'Age is required.');

      const txs = [];
      const zapped = await req.wallet.zap(acct, age);

      for (const hash of zapped)
        txs.push(hash.toString('hex'));

      res.json(200, { success: true, txs: txs });
    });

    // Abandon Wallet TX
    this.del('/wallet/:id/tx/:hash', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');

      enforce(hash, 'Hash is required.');

      await req.wallet.abandon(hash);

      res.json(200, { success: true });
    });

    // List blocks
    this.get('/wallet/:id/block', async (req, res) => {
      const heights = await req.wallet.getBlocks();
      res.json(200, heights);
    });

    // Get Block Record
    this.get('/wallet/:id/block/:height', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const height = valid.u32('height');

      enforce(height != null, 'Height is required.');

      const block = await req.wallet.getBlock(height);

      if (!block) {
        res.json(404);
        return;
      }

      res.json(200, block.toJSON());
    });

    // Add key
    this.put('/wallet/:id/shared-key', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const b58 = valid.str('accountKey');

      enforce(b58, 'Key is required.');

      const key = HDPublicKey.fromBase58(b58, this.network);
      const added = await req.wallet.addSharedKey(acct, key);

      res.json(200, {
        success: true,
        addedKey: added
      });
    });

    // Remove key
    this.del('/wallet/:id/shared-key', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const b58 = valid.str('accountKey');

      enforce(b58, 'Key is required.');

      const key = HDPublicKey.fromBase58(b58, this.network);
      const removed = await req.wallet.removeSharedKey(acct, key);

      res.json(200, {
        success: true,
        removedKey: removed
      });
    });

    // Get key by address
    this.get('/wallet/:id/key/:address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const b58 = valid.str('address');

      enforce(b58, 'Address is required.');

      const addr = Address.fromString(b58, this.network);
      const key = await req.wallet.getKey(addr);

      if (!key) {
        res.json(404);
        return;
      }

      res.json(200, key.getJSON(this.network));
    });

    // Get private key
    this.get('/wallet/:id/wif/:address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const b58 = valid.str('address');
      const passphrase = valid.str('passphrase');

      enforce(b58, 'Address is required.');

      const addr = Address.fromString(b58, this.network);
      const key = await req.wallet.getPrivateKey(addr, passphrase);

      if (!key) {
        res.json(404);
        return;
      }

      res.json(200, { privateKey: key.toSecret(this.network) });
    });

    // Get address
    this.get('/wallet/:id/address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const index = valid.u32('index');
      const addr = await req.wallet.getReceive(acct, index);

      res.json(200, addr.getJSON(this.network));
    });

    // Get change address
    this.get('/wallet/:id/change', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const index = valid.u32('index');
      const addr = await req.wallet.getChange(acct, index);

      res.json(200, addr.getJSON(this.network));
    });

    // Create address
    this.post('/wallet/:id/address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const addr = await req.wallet.createReceive(acct);

      res.json(200, addr.getJSON(this.network));
    });

    // Create change address
    this.post('/wallet/:id/change', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const addr = await req.wallet.createChange(acct);

      res.json(200, addr.getJSON(this.network));
    });

    // Wallet Balance
    this.get('/wallet/:id/balance', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const balance = await req.wallet.getBalance(acct);

      if (!balance) {
        res.json(404);
        return;
      }

      res.json(200, balance.toJSON());
    });

    // Wallet UTXOs
    this.get('/wallet/:id/coin', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const coins = await req.wallet.getCoins(acct);
      const result = [];

      common.sortCoins(coins);

      for (const coin of coins)
        result.push(coin.getJSON(this.network));

      res.json(200, result);
    });

    this.coinDistributionCache = new Map();

    // Wallet UTXO summary statistics
    // Counts the total HNS within each range of output values for all UTXOs
    this.get('/wallet/:id/coin-distribution', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const bucketExponent = valid.float('bucketExponent');
      enforce(bucketExponent != null, 'Bucket exponent is required.');

      const cacheKey = `${req.wallet.id};${acct};${bucketExponent}`;

      const calculateResult = async () => {
        const coins = await req.wallet.getCoins(acct);
        const coinsByValue = coins.sort((a, b) => a.value - b.value);

        const buckets = [makeDistributionBucket(0, 100000)];
        for (const coin of coinsByValue) {
          // First, figure out which bucket this coin belongs in
          let currentMax = buckets[buckets.length - 1].maxValue;
          while (coin.value >= currentMax) {
            const nextMax = Math.floor(currentMax * bucketExponent);
            const nextBucket = makeDistributionBucket(currentMax, nextMax);
            buckets.push(nextBucket);
            currentMax = nextMax;
          }
          const currentBucket = buckets[buckets.length - 1];

          // Next, add this coin's details to this bucket's statistics
          const covenantType = rules.typesByVal[coin.covenant.type];
          // eslint-disable-next-line no-prototype-builtins
          if (!currentBucket.counts.hasOwnProperty(covenantType)) {
            currentBucket.counts[covenantType] = 0;
            if (isLockedCovenant(coin.covenant)) {
              currentBucket.lockedCounts[covenantType] = 0;
            }
          }
          currentBucket.totalValue += coin.value;
          currentBucket.counts[covenantType] += 1;

          if (isLockedCovenant(coin.covenant)) {
            currentBucket.totalLockedValue += coin.value;
            currentBucket.lockedCounts[covenantType] += 1;
          }
        }

        const keyedBucket = {};
        keyedBucket[`${req.wallet.id}/${acct}`] = buckets;
        const result = { distributions: keyedBucket };

        this.coinDistributionCache.set(cacheKey, {
          height: req.wallet.wdb.height,
          item: result
        });

        return result;
      };

      // if we have a cached response, use it
      if (this.coinDistributionCache.has(cacheKey)) {
        const cacheEntry = this.coinDistributionCache.get(cacheKey);

        // if the height of the cached response is stale, schedule an update
        if (cacheEntry.height < req.wallet.wdb.height) {
          nextTick(calculateResult);
        }

        return res.json(200, {
          ...cacheEntry.item,
          cachedHeight: cacheEntry.height
        });
      }

      const result = await calculateResult();
      return res.json(200, result);
    });

    // Locked coins
    this.get('/wallet/:id/locked', async (req, res) => {
      const locked = req.wallet.getLocked();
      const result = [];

      for (const outpoint of locked)
        result.push(outpoint.toJSON());

      res.json(200, result);
    });

    // Lock coin
    this.put('/wallet/:id/locked/:hash/:index', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');
      const index = valid.u32('index');

      enforce(hash, 'Hash is required.');
      enforce(index != null, 'Index is required.');

      const outpoint = new Outpoint(hash, index);

      req.wallet.lockCoin(outpoint);

      res.json(200, { success: true });
    });

    // Unlock coin
    this.del('/wallet/:id/locked/:hash/:index', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');
      const index = valid.u32('index');

      enforce(hash, 'Hash is required.');
      enforce(index != null, 'Index is required.');

      const outpoint = new Outpoint(hash, index);

      req.wallet.unlockCoin(outpoint);

      res.json(200, { success: true });
    });

    // Wallet Coin
    this.get('/wallet/:id/coin/:hash/:index', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');
      const index = valid.u32('index');

      enforce(hash, 'Hash is required.');
      enforce(index != null, 'Index is required.');

      const coin = await req.wallet.getCoin(hash, index);

      if (!coin) {
        res.json(404);
        return;
      }

      res.json(200, coin.getJSON(this.network));
    });

    // Wallet TXs
    this.get('/wallet/:id/tx/history', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const txs = await req.wallet.getHistory(acct);

      common.sortTX(txs);

      const details = await req.wallet.toDetails(txs);

      const result = [];

      for (const item of details)
        result.push(item.getJSON(this.network, this.wdb.height));

      res.json(200, result);
    });

    // Wallet Pending TXs
    this.get('/wallet/:id/tx/unconfirmed', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const txs = await req.wallet.getPending(acct);

      common.sortTX(txs);

      const details = await req.wallet.toDetails(txs);
      const result = [];

      for (const item of details)
        result.push(item.getJSON(this.network, this.wdb.height));

      res.json(200, result);
    });

    // Wallet TXs within time range
    this.get('/wallet/:id/tx/range', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');

      const options = {
        start: valid.u32('start'),
        end: valid.u32('end'),
        limit: valid.u32('limit'),
        reverse: valid.bool('reverse')
      };

      const txs = await req.wallet.getRange(acct, options);
      const details = await req.wallet.toDetails(txs);
      const result = [];

      for (const item of details)
        result.push(item.getJSON(this.network, this.wdb.height));

      res.json(200, result);
    });

    // Last Wallet TXs
    this.get('/wallet/:id/tx/last', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const limit = valid.u32('limit');
      const txs = await req.wallet.getLast(acct, limit);
      const details = await req.wallet.toDetails(txs);
      const result = [];

      for (const item of details)
        result.push(item.getJSON(this.network, this.wdb.height));

      res.json(200, result);
    });

    // Wallet TX
    this.get('/wallet/:id/tx/:hash', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');

      enforce(hash, 'Hash is required.');

      const tx = await req.wallet.getTX(hash);

      if (!tx) {
        res.json(404);
        return;
      }

      const details = await req.wallet.toDetails(tx);

      res.json(200, details.getJSON(this.network, this.wdb.height));
    });

    // Resend
    this.post('/wallet/:id/resend', async (req, res) => {
      await req.wallet.resend();
      res.json(200, { success: true });
    });

    // Wallet Name States
    this.get('/wallet/:id/name', async (req, res) => {
      const height = this.wdb.height;
      const network = this.network;

      const names = await req.wallet.getNames();
      const items = [];

      for (const ns of names)
        items.push(ns.getJSON(height, network));

      res.json(200, items);
    });

    // Wallet Name State
    this.get('/wallet/:id/name/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name, 'Must pass name.');
      enforce(rules.verifyName(name), 'Must pass valid name.');

      const height = this.wdb.height;
      const network = this.network;
      const ns = await req.wallet.getNameStateByName(name);

      if (!ns)
        return res.json(404);

      return res.json(200, ns.getJSON(height, network));
    });

    // Wallet Name State
    this.get('/wallet/:id/owns-name/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name, 'Must pass name.');
      enforce(rules.verifyName(name), 'Must pass valid name.');

      const height = this.wdb.height;
      const network = this.network;
      /** @type {Wallet} */
      const wallet = req.wallet;
      const notFound = () => res.json(
        404,
        { message: `${name} not found in wallet ${wallet.id}` }
      );

      const ns = await wallet.getNameStateByName(name);
      if (!ns)
        return notFound();

      const tx = await wallet.getTX(ns.owner.hash);
      if (!tx)
        return notFound();

      const details = await wallet.toDetails(tx);
      const ownerOutput = details.outputs[ns.owner.index];

      if (await wallet.hasAddress(ownerOutput.address)) {
        return res.json(200, ns.getJSON(height, network));
      }

      return notFound();
    });

    // Wallet Auctions
    this.get('/wallet/:id/auction', async (req, res) => {
      const height = this.wdb.height;
      const network = this.network;

      const names = await req.wallet.getNames();
      const items = [];

      for (const ns of names) {
        const bids = await req.wallet.getBidsByName(ns.name);
        const reveals = await req.wallet.getRevealsByName(ns.name);
        const info = ns.getJSON(height, network);

        info.bids = [];
        info.reveals = [];

        for (const bid of bids)
          info.bids.push(bid.toJSON());

        for (const reveal of reveals)
          info.reveals.push(reveal.toJSON());

        items.push(info);
      }

      return res.json(200, items);
    });

    // Wallet Auction
    this.get('/wallet/:id/auction/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name, 'Must pass name.');
      enforce(rules.verifyName(name), 'Must pass valid name.');

      const height = this.wdb.height;
      const network = this.network;

      const ns = await req.wallet.getNameStateByName(name);

      if (!ns)
        return res.json(404);

      const bids = await req.wallet.getBidsByName(name);
      const reveals = await req.wallet.getRevealsByName(name);

      const info = ns.getJSON(height, network);
      info.bids = [];
      info.reveals = [];

      for (const bid of bids)
        info.bids.push(bid.toJSON());

      for (const reveal of reveals)
        info.reveals.push(reveal.toJSON());

      return res.json(200, info);
    });

    // All Wallet Bids
    this.get('/wallet/:id/bid', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const own = valid.bool('own', false);

      const bids = await req.wallet.getBidsByName();
      const items = [];

      for (const bid of bids) {
        if (!own || bid.own)
          items.push(bid.toJSON());
      }

      res.json(200, items);
    });

    // Wallet Bids by Name
    this.get('/wallet/:id/bid/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      let own = valid.bool('own', false);

      if (name)
        enforce(rules.verifyName(name), 'Must pass valid name.');

      if (!name)
        own = true;

      const bids = await req.wallet.getBidsByName(name);
      const items = [];

      for (const bid of bids) {
        if (!own || bid.own)
          items.push(bid.toJSON());
      }

      res.json(200, items);
    });

    // All Wallet Reveals
    this.get('/wallet/:id/reveal', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const own = valid.bool('own', false);

      const reveals = await req.wallet.getRevealsByName();
      const items = [];

      for (const brv of reveals) {
        if (!own || brv.own)
          items.push(brv.toJSON());
      }

      res.json(200, items);
    });

    // Wallet Reveals by Name
    this.get('/wallet/:id/reveal/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      let own = valid.bool('own', false);

      if (name)
        enforce(rules.verifyName(name), 'Must pass valid name.');

      if (!name)
        own = true;

      const reveals = await req.wallet.getRevealsByName(name);
      const items = [];

      for (const brv of reveals) {
        if (!own || brv.own)
          items.push(brv.toJSON());
      }

      res.json(200, items);
    });

    // Name Resource
    this.get('/wallet/:id/resource/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name, 'Must pass name.');
      enforce(rules.verifyName(name), 'Must pass valid name.');

      const ns = await req.wallet.getNameStateByName(name);

      if (!ns || ns.data.length === 0)
        return res.json(404);

      try {
        const resource = Resource.decode(ns.data);
        return res.json(200, resource.toJSON());
      } catch (e) {
        return res.json(400);
      }
    });

    // Regenerate Nonce
    this.get('/wallet/:id/nonce/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const addr = valid.str('address');
      const bid = valid.ufixed('bid');

      enforce(name, 'Name is required.');
      enforce(rules.verifyName(name), 'Valid name is required.');
      enforce(addr, 'Address is required.');
      enforce(bid != null, 'Bid is required.');

      let address;
      try {
        address = Address.fromString(addr, this.network);
      } catch (e) {
        return req.json(400);
      }

      const nameHash = rules.hashName(name);
      const nonce = await req.wallet.generateNonce(nameHash, address, bid);
      const blind = rules.blind(bid, nonce);

      return res.json(200, {
        address: address.toString(this.network),
        blind: blind.toString('hex'),
        nonce: nonce.toString('hex'),
        bid: bid,
        name: name,
        nameHash: nameHash.toString('hex')
      });
    });

    // Create Open
    this.post('/wallet/:id/open', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(name, 'Name is required.');
      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendOpen(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createOpen(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Bid
    this.post('/wallet/:id/bid', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const bid = valid.u64('bid');
      const lockup = valid.u64('lockup');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(name, 'Name is required.');
      enforce(bid != null, 'Bid is required.');
      enforce(lockup != null, 'Lockup is required.');
      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendBid(name, bid, lockup, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createBid(name, bid, lockup, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create auction-related transactions in advance (bid and reveal for now)
    this.post('/wallet/:id/auction', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const bid = valid.u64('bid');
      const lockup = valid.u64('lockup');
      const passphrase = valid.str('passphrase');
      const sign = valid.bool('sign', true);
      const broadcastBid = valid.bool('broadcastBid');
      const abortOnClose = valid.str('abortOnClose', true);

      enforce(name, 'Name is required.');
      enforce(bid != null, 'Bid is required.');
      enforce(lockup != null, 'Lockup is required.');
      enforce(broadcastBid != null, 'broadcastBid is required.');
      enforce(broadcastBid ? sign : true, 'Must sign when broadcasting.');

      const options = TransactionOptions.fromValidator(valid, res.signal);
      const auctionTxs = await req.wallet.createAuctionTxs(
        name,
        bid,
        lockup,
        options
      );

      if (abortOnClose && res.closed)
        throw abortError();

      if (sign) {
        if (broadcastBid) {
          auctionTxs.bid = await req.wallet.sendMTX(auctionTxs.bid, passphrase);
        } else {
          await req.wallet.sign(auctionTxs.bid, passphrase);
        }
        await req.wallet.sign(auctionTxs.reveal, passphrase);
      }

      return res.json(200, {
        bid: auctionTxs.bid.getJSON(this.network),
        reveal: auctionTxs.reveal.getJSON(this.network)
      });
    });

    // Create Reveal
    this.post('/wallet/:id/reveal', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast && !name) {
        const tx = await req.wallet.sendRevealAll(options);
        return res.json(200, tx.getJSON(this.network));
      }

      if (broadcast && name) {
        const tx = await req.wallet.sendReveal(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      let mtx;

      if (!name)
        mtx = await req.wallet.createRevealAll(options);
      else
        mtx = await req.wallet.createReveal(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Redeem
    this.post('/wallet/:id/redeem', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast && !name) {
        const tx = await req.wallet.sendRedeemAll(options);
        return res.json(200, tx.getJSON(this.network));
      }

      if (broadcast && name) {
        const tx = await req.wallet.sendRedeem(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      let mtx;

      if (!name)
        mtx = await req.wallet.createRedeemAll(options);
      else
        mtx = await req.wallet.createRedeem(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Update
    this.post('/wallet/:id/update', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const data = valid.obj('data');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');
      enforce(data, 'Must pass data.');

      let resource;
      try {
        resource = Resource.fromJSON(data);
      } catch (e) {
        return res.json(400);
      }

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendUpdate(name, resource, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createUpdate(name, resource, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create raw Update - this route will be overriden by the plugin
    this.post('/wallet/:id/update/raw', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const resourceHex = valid.str('resourceHex');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');
      enforce(resourceHex, 'Must pass resourceHex.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendRawUpdate(name, resourceHex, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createRawUpdate(name, resourceHex, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Renewal
    this.post('/wallet/:id/renewal', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendRenewal(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createRenewal(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Transfer
    this.post('/wallet/:id/transfer', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const address = valid.str('address');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');
      enforce(address, 'Must pass address.');

      const addr = Address.fromString(address, this.network);
      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendTransfer(name, addr, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createTransfer(name, addr, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Cancel
    this.post('/wallet/:id/cancel', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendCancel(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createCancel(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Finalize
    this.post('/wallet/:id/finalize', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendFinalize(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createFinalize(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // Create Revoke
    this.post('/wallet/:id/revoke', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');
      const broadcast = valid.bool('broadcast', true);
      const sign = valid.bool('sign', true);

      enforce(broadcast ? sign : true, 'Must sign when broadcasting.');
      enforce(name, 'Must pass name.');

      const options = TransactionOptions.fromValidator(valid, res.signal);

      if (broadcast) {
        const tx = await req.wallet.sendRevoke(name, options);
        return res.json(200, tx.getJSON(this.network));
      }

      const mtx = await req.wallet.createRevoke(name, options);

      if (sign)
        await req.wallet.sign(mtx, options.passphrase);

      return res.json(200, mtx.getJSON(this.network));
    });

    // resync wallet db
    this.post('/wallet/:id/resync', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const acct = valid.str('account');
      const receiveDepth = valid.u32('receive');
      const changeDepth = valid.u32('change');

      await req.wallet.resyncDepth(acct, receiveDepth, changeDepth);

      res.json(200, { success: true });
    });

    // check txdb cache sync
    this.get('/wallet/:id/is-txdb-consistent', async (req, res) => {
      try {
        const isTxdbConsistent = await req.wallet.isTxdbConsistent();
        return res.json(200, {
          success: true,
          isTxdbConsistent
        });
      } catch (e) {
        return res.json(500, {
          success: false,
          message: 'lock error'
        });
      }
    });
  }

  /**
   * Initialize websockets.
   * @private
   */

  initSockets() {
    const handleTX = (event, wallet, tx, details) => {
      const name = `w:${wallet.id}`;

      if (!this.channel(name) && !this.channel('w:*'))
        return;

      const json = details.getJSON(this.network, this.wdb.liveHeight());

      if (this.channel(name))
        this.to(name, event, wallet.id, json);

      if (this.channel('w:*'))
        this.to('w:*', event, wallet.id, json);
    };

    this.wdb.on('tx', (wallet, tx, details) => {
      handleTX('tx', wallet, tx, details);
    });

    this.wdb.on('confirmed', (wallet, tx, details) => {
      handleTX('confirmed', wallet, tx, details);
    });

    this.wdb.on('unconfirmed', (wallet, tx, details) => {
      handleTX('unconfirmed', wallet, tx, details);
    });

    this.wdb.on('conflict', (wallet, tx, details) => {
      handleTX('conflict', wallet, tx, details);
    });

    this.wdb.on('balance', (wallet, balance) => {
      const name = `w:${wallet.id}`;

      if (!this.channel(name) && !this.channel('w:*'))
        return;

      const json = balance.toJSON();

      if (this.channel(name))
        this.to(name, 'balance', wallet.id, json);

      if (this.channel('w:*'))
        this.to('w:*', 'balance', wallet.id, json);
    });

    this.wdb.on('address', (wallet, receive) => {
      const name = `w:${wallet.id}`;

      if (!this.channel(name) && !this.channel('w:*'))
        return;

      const json = [];

      for (const addr of receive)
        json.push(addr.getJSON(this.network));

      if (this.channel(name))
        this.to(name, 'address', wallet.id, json);

      if (this.channel('w:*'))
        this.to('w:*', 'address', wallet.id, json);
    });
  }

  /**
   * Handle new websocket.
   * @private
   * @param {WebSocket} socket
   */

  handleSocket(socket) {
    socket.hook('auth', (...args) => {
      if (socket.channel('auth'))
        throw new Error('Already authed.');

      if (!this.options.noAuth) {
        const valid = new Validator(args);
        const key = valid.str(0, '');

        if (key.length > 255)
          throw new Error('Invalid API key.');

        const data = Buffer.from(key, 'utf8');
        const hash = sha256.digest(data);

        if (!safeEqual(hash, this.options.apiHash))
          throw new Error('Invalid API key.');
      }

      socket.join('auth');

      this.logger.info('Successful auth from %s.', socket.host);

      this.handleAuth(socket);

      return null;
    });
  }

  /**
   * Handle new auth'd websocket.
   * @private
   * @param {WebSocket} socket
   */

  handleAuth(socket) {
    socket.hook('join', async (...args) => {
      const valid = new Validator(args);
      const id = valid.str(0, '');
      const token = valid.buf(1);

      if (!id)
        throw new Error('Invalid parameter.');

      if (!this.options.walletAuth) {
        socket.join('admin');
      } else if (token) {
        if (safeEqual(token, this.options.adminToken))
          socket.join('admin');
      }

      if (socket.channel('admin') || !this.options.walletAuth) {
        socket.join(`w:${id}`);
        return null;
      }

      if (id === '*')
        throw new Error('Bad token.');

      if (!token)
        throw new Error('Invalid parameter.');

      let wallet;
      try {
        wallet = await this.wdb.auth(id, token);
      } catch (e) {
        this.logger.info('Wallet auth failure for %s: %s.', id, e.message);
        throw new Error('Bad token.');
      }

      if (!wallet)
        throw new Error('Wallet does not exist.');

      this.logger.info('Successful wallet auth for %s.', id);

      socket.join(`w:${id}`);

      return null;
    });

    socket.hook('leave', (...args) => {
      const valid = new Validator(args);
      const id = valid.str(0, '');

      if (!id)
        throw new Error('Invalid parameter.');

      socket.leave(`w:${id}`);

      return null;
    });
  }

  /**
   * Registers a new http handler at provided path
   * the handler method is passed regular req, res along
   * with a context object that holds vallet specific
   * objects that might be used to extend wallet plugin
   * functionality
   *
   * @param {String} httpMethod string value of one of
   * 'post', 'get', 'put', 'patch', 'delete'
   * @param {String} path location handler is listening
   * @param {Function} handler http handler that will handle requests
   * arriving to `path` registered
   * @param {Object} context context
   * @returns {void}
   */

  registerRoute(httpMethod, path, handler, context) {
    const validHttpMethods = ['post', 'get', 'put', 'patch', 'del'];
    assert(httpMethod && typeof httpMethod === 'string',
    'httpMethod parameter must be provided and it must be a string');
    assert(validHttpMethods.includes(httpMethod.toLowerCase()),
    'httpMethod must be one of ' + validHttpMethods.join(','));

    // update context
    context.TransactionOptions = TransactionOptions;
    context.Validator = Validator;
    context.network = this.network;

    // to take precedence over other routes
    const router = this.routes;
    if (httpMethod === 'post') {
      router._post.unshift(new Route(path, async (req, res) => {
        await handler(req, res, context);
      }));
    } else if (httpMethod === 'get') {
      router._get.unshift(new Route(path, async (req, res) => {
        await handler(req, res, context);
      }));
    } else if (httpMethod === 'put') {
      router._put.unshift(new Route(path, async (req, res) => {
        await handler(req, res, context);
      }));
    } else if (httpMethod === 'patch') {
      router._patch.unshift(new Route(path, async (req, res) => {
        await handler(req, res, context);
      }));
    } else if (httpMethod === 'del') {
      router._del.unshift(new Route(path, async (req, res) => {
        await handler(req, res, context);
      }));
    }
    // this[httpMethod](path, async (req, res) => {
    //   await handler(req, res, context);
    // });
  }
}

class HTTPOptions {
  /**
   * HTTPOptions
   * @alias module:http.HTTPOptions
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = null;
    this.node = null;
    this.apiKey = base58.encode(random.randomBytes(20));
    this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    this.adminToken = random.randomBytes(32);
    this.serviceHash = this.apiHash;
    this.noAuth = false;
    this.cors = false;
    this.walletAuth = false;

    this.prefix = null;
    this.host = '127.0.0.1';
    this.port = 8080;
    this.ssl = false;
    this.keyFile = null;
    this.certFile = null;

    this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  fromOptions(options) {
    assert(options);
    assert(options.node && typeof options.node === 'object',
      'HTTP Server requires a WalletDB.');

    this.node = options.node;
    this.network = options.node.network;
    this.logger = options.node.logger;
    this.port = this.network.walletPort;

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.apiKey != null) {
      assert(typeof options.apiKey === 'string',
        'API key must be a string.');
      assert(options.apiKey.length <= 255,
        'API key must be under 255 bytes.');
      this.apiKey = options.apiKey;
      this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    }

    if (options.adminToken != null) {
      if (typeof options.adminToken === 'string') {
        assert(options.adminToken.length === 64,
          'Admin token must be a 32 byte hex string.');
        const token = Buffer.from(options.adminToken, 'hex');
        assert(token.length === 32,
          'Admin token must be a 32 byte hex string.');
        this.adminToken = token;
      } else {
        assert(Buffer.isBuffer(options.adminToken),
          'Admin token must be a hex string or buffer.');
        assert(options.adminToken.length === 32,
          'Admin token must be 32 bytes.');
        this.adminToken = options.adminToken;
      }
    }

    if (options.noAuth != null) {
      assert(typeof options.noAuth === 'boolean');
      this.noAuth = options.noAuth;
    }

    if (options.cors != null) {
      assert(typeof options.cors === 'boolean');
      this.cors = options.cors;
    }

    if (options.walletAuth != null) {
      assert(typeof options.walletAuth === 'boolean');
      this.walletAuth = options.walletAuth;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.keyFile = path.join(this.prefix, 'key.pem');
      this.certFile = path.join(this.prefix, 'cert.pem');
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = options.host;
    }

    if (options.port != null) {
      assert((options.port & 0xffff) === options.port,
        'Port must be a number.');
      this.port = options.port;
    }

    if (options.ssl != null) {
      assert(typeof options.ssl === 'boolean');
      this.ssl = options.ssl;
    }

    if (options.keyFile != null) {
      assert(typeof options.keyFile === 'string');
      this.keyFile = options.keyFile;
    }

    if (options.certFile != null) {
      assert(typeof options.certFile === 'string');
      this.certFile = options.certFile;
    }

    // Allow no-auth implicitly
    // if we're listening locally.
    if (!options.apiKey) {
      if (this.host === '127.0.0.1' || this.host === '::1')
        this.noAuth = true;
    }

    return this;
  }

  /**
   * Instantiate http options from object.
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  static fromOptions(options) {
    return new HTTPOptions().fromOptions(options);
  }
}

const NULL_SIGNAL = {
  get aborted() {
    return false;
  }
};

class TransactionOptions {
  /**
   * TransactionOptions
   * @alias module:http.TransactionOptions
   * @constructor
   * @param {Validator} valid
   * @param {Signal} signal
   */

  constructor(valid, signal) {
    this.signal = NULL_SIGNAL;

    if (valid)
      return this.fromValidator(valid, signal);
  }

  /**
   * Inject properties from Validator.
   * @private
   * @param {Validator} valid
   * @param {Signal} signal
   * @returns {TransactionOptions}
   */

  fromValidator(valid, signal) {
    assert(valid);

    this.rate = valid.u64('rate');
    this.maxFee = valid.u64('maxFee');
    this.selection = valid.str('selection');
    this.smart = valid.bool('smart');
    this.account = valid.str('account');
    this.locktime = valid.u64('locktime');
    this.sort = valid.bool('sort');
    this.subtractFee = valid.bool('subtractFee');
    this.subtractIndex = valid.i32('subtractIndex');
    this.depth = valid.u32(['confirmations', 'depth']);
    this.paths = valid.bool('paths');
    this.passphrase = valid.str('passphrase');
    this.hardFee = valid.u64('hardFee');
    this.abortOnClose = valid.bool('abortOnClose', true);

    if (this.abortOnClose) {
      assert(signal);
      this.signal = signal;
    }

    this.outputs = [];

    if (valid.has('outputs')) {
      const outputs = valid.array('outputs');

      for (const output of outputs) {
        const valid = new Validator(output);

        let addr = valid.str('address');

        if (addr)
          addr = Address.fromString(addr, this.network);

        let covenant = valid.obj('covenant');

        if (covenant)
          covenant = Covenant.fromJSON(covenant);

        this.outputs.push({
          value: valid.u64('value'),
          address: addr,
          covenant: covenant
        });
      }
    }

    return this;
  }

  /*
   * Instantiate transaction options
   * from Validator.
   * @param {Validator} valid
   * @param {Signal} signal
   * @returns {TransactionOptions}
   */

  static fromValidator(valid, signal) {
    return new this().fromValidator(valid, signal);
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}

function abortError() {
  const err = new Error('abort: Client closed request.');
  // 499 is non-std, so use 408.
  err.statusCode = 408;
  return err;
}

function makeDistributionBucket(minValue, maxValue) {
  return {
    minValue,
    maxValue,
    counts: {},
    lockedCounts: {},
    totalValue: 0,
    totalLockedValue: 0
  };
}

/**
 * @param {Covenant} covenant a covenant to check
 * @returns {Boolean} whether or not the covenant is 'Locked'
 */

function isLockedCovenant(covenant) {
  const lockedTypes = [
    rules.types.BID,
    rules.types.FINALIZE,
    rules.types.REGISTER,
    rules.types.REVEAL,
    rules.types.REVOKE,
    rules.types.TRANSFER,
    rules.types.UPDATE
  ];
  return lockedTypes.includes(covenant.type);
}

/*
 * Expose
 */

module.exports = HTTP;

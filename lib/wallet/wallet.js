/* eslint-disable max-len */
/*
 * wallet.js - wallet object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const { Lock } = require('bmutex');
const base58 = require('bcrypto/lib/encoding/base58');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const cleanse = require('bcrypto/lib/cleanse');
const TXDB = require('./cachedtxdb');
const Path = require('./path');
const common = require('./common');
const Address = require('../primitives/address');
const MTX = require('../primitives/mtx');
const Script = require('../script/script');
const CoinView = require('../coins/coinview');
const WalletCoinView = require('./walletcoinview');
const WalletKey = require('./walletkey');
const HD = require('../hd/hd');
const Output = require('../primitives/output');
const Account = require('./account');
const MasterKey = require('./masterkey');
const policy = require('../protocol/policy');
const consensus = require('../protocol/consensus');
const rules = require('../covenants/rules');
const { Resource } = require('../dns/resource');
const Claim = require('../primitives/claim');
const reserved = require('../covenants/reserved');
const ownership = require('../covenants/ownership');
const { states } = require('../covenants/namestate');
const { types } = rules;
const { Mnemonic } = HD;
const { BufferSet } = require('buffer-map');
const util = require('../utils/util');

/** @typedef {import('../covenants/namestate')} NameState */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('./txdb').Details} Details */

/**
 * @typedef {Object} BidInfo
 * @property {String} name
 * @property {Number} value
 * @property {Number} lockup
 */

/**
 * @typedef {Object} OutpointInfo
 * @property {Output} output
 * @property {Outpoint} outpoint
 */

/**
 * @typedef {Object} ErrorMessage
 * @property {string} name
 * @property {string} errorMessage
 */

/**
 * @typedef {Object} BatchResponse
 * @property {MTX} mtx
 * @property {ErrorMessage[]} errors
 */

/**
 * @typedef {Object} BatchSendResponse
 * @property {TX} tx
 * @property {MTX} mtx
 * @property {ErrorMessage[]} errors
 */

/**
 * @typedef {Object} TransferInfo
 * @property {String} name
 * @property {Address} address
 */

const Coin = require('../primitives/coin');
const Outpoint = require('../primitives/outpoint');

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);
const MAX_REVEALS_PER_BATCH_TX = 200;

/**
 * Wallet
 * @alias module:wallet.Wallet
 * @extends EventEmitter
 */

class Wallet extends EventEmitter {
  /**
   * Create a wallet.
   * @constructor
   * @param {Object} options
   */

  constructor(wdb, options) {
    super();

    assert(wdb, 'WDB required.');

    this.wdb = wdb;
    this.db = wdb.db;
    this.network = wdb.network;
    this.logger = wdb.logger;
    this.writeLock = new Lock();
    this.fundLock = new Lock();

    this.wid = 0;
    this.id = null;
    this.watchOnly = false;
    this.accountDepth = 0;
    this.token = consensus.ZERO_HASH;
    this.tokenDepth = 0;
    this.master = new MasterKey();

    this.txdb = new TXDB(this.wdb);

    this.maxAncestors = policy.MEMPOOL_MAX_ANCESTORS;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    if (!options)
      return this;

    let key = options.master;
    let id, token, mnemonic;

    if (key) {
      if (typeof key === 'string')
        key = HD.PrivateKey.fromBase58(key, this.network);

      assert(HD.isPrivate(key),
        'Must create wallet with hd private key.');
    } else {
      mnemonic = new Mnemonic(options.mnemonic);
      key = HD.fromMnemonic(mnemonic, options.password);
    }

    this.master.fromKey(key, mnemonic);

    if (options.wid != null) {
      assert((options.wid >>> 0) === options.wid);
      this.wid = options.wid;
    }

    if (options.id) {
      assert(common.isName(options.id), 'Bad wallet ID.');
      id = options.id;
    }

    if (options.watchOnly != null) {
      assert(typeof options.watchOnly === 'boolean');
      this.watchOnly = options.watchOnly;
    }

    if (options.accountDepth != null) {
      assert((options.accountDepth >>> 0) === options.accountDepth);
      this.accountDepth = options.accountDepth;
    }

    if (options.token) {
      assert(Buffer.isBuffer(options.token));
      assert(options.token.length === 32);
      token = options.token;
    }

    if (options.tokenDepth != null) {
      assert((options.tokenDepth >>> 0) === options.tokenDepth);
      this.tokenDepth = options.tokenDepth;
    }

    if (options.maxAncestors != null) {
      assert((options.maxAncestors >>> 0) === options.maxAncestors);
      this.maxAncestors = options.maxAncestors;
    }

    if (!id)
      id = this.getID();

    if (!token)
      token = this.getToken(this.tokenDepth);

    this.id = id;
    this.token = token;

    return this;
  }

  /**
   * Instantiate wallet from options.
   * @param {WalletDB} wdb
   * @param {Object} options
   * @returns {Wallet}
   */

  static fromOptions(wdb, options) {
    return new this(wdb).fromOptions(options);
  }

  /**
   * Attempt to intialize the wallet (generating
   * the first addresses along with the lookahead
   * addresses). Called automatically from the
   * walletdb.
   * @returns {Promise}
   */

  async init(options, passphrase) {
    if (passphrase)
      await this.master.encrypt(passphrase);

    const account = await this._createAccount(options, passphrase);
    assert(account);

    this.logger.info('Wallet initialized (%s).', this.id);

    return await this.txdb.open(this);
  }

  /**
   * Open wallet (done after retrieval).
   * @returns {Promise}
   */

  async open() {
    const account = await this.getAccount(0);

    if (!account)
      throw new Error('Default account not found.');

    await this.txdb.open(this);
    this.logger.info('Wallet opened (%s).', this.id);
  }

  async isTxdbConsistent() {
    const unlock = await this.writeLock.lock();
    try {
      return await this.txdb.isConsistent();
    } finally {
      unlock();
    }
  }

  /**
   * Close the wallet, unregister with the database.
   * @returns {Promise<void>} nothing
   */
  async destroy() {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();
    try {
      await this.master.destroy();
      this.writeLock.destroy();
      this.fundLock.destroy();
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Run change address migration.
   * @param {Batch} b bdb batch
   * @returns {Promise<void>} nothing
   */
  async migrateChange(b) {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();

    try {
      return await this._migrateChange(b);
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Run change address migration (without a lock).
   * @param {Batch} b
   */

  async _migrateChange(b) {
    let total = 0;

    for (let i = 0; i < this.accountDepth; i++) {
      const account = await this.getAccount(i);

      for (let i = 0; i < account.changeDepth + account.lookahead; i++) {
        const key = account.deriveChange(i);
        const path = key.toPath();

        if (!await this.wdb.hasPath(account.wid, path.hash)) {
          await this.wdb.savePath(b, account.wid, path);
          total += 1;
        }
      }
    }

    return total;
  }

  /**
   * Add a public account key to the wallet (multisig).
   * Saves the key in the wallet database.
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise}
   */

  async addSharedKey(acct, key) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._addSharedKey(acct, key);
    } finally {
      unlock();
    }
  }

  /**
   * Add a public account key to the wallet without a lock.
   * @private
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise}
   */

  async _addSharedKey(acct, key) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const result = await account.addSharedKey(b, key);
    await b.write();

    return result;
  }

  /**
   * Remove a public account key from the wallet (multisig).
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise}
   */

  async removeSharedKey(acct, key) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._removeSharedKey(acct, key);
    } finally {
      unlock();
    }
  }

  /**
   * Remove a public account key from the wallet (multisig).
   * @private
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise}
   */

  async _removeSharedKey(acct, key) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const result = await account.removeSharedKey(b, key);
    await b.write();

    return result;
  }

  /**
   * Change or set master key's passphrase.
   * @param {String|Buffer} passphrase
   * @param {String|Buffer} old
   * @returns {Promise}
   */

  async setPassphrase(passphrase, old) {
    if (old != null)
      await this.decrypt(old);

    await this.encrypt(passphrase);
  }

  /**
   * Encrypt the wallet permanently.
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async encrypt(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._encrypt(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Encrypt the wallet permanently, without a lock.
   * @private
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async _encrypt(passphrase) {
    const key = await this.master.encrypt(passphrase, true);
    const b = this.db.batch();

    try {
      await this.wdb.encryptKeys(b, this.wid, key);
    } finally {
      cleanse(key);
    }

    this.save(b);

    await b.write();
  }

  /**
   * Decrypt the wallet permanently.
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async decrypt(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._decrypt(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Decrypt the wallet permanently, without a lock.
   * @private
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async _decrypt(passphrase) {
    const key = await this.master.decrypt(passphrase, true);
    const b = this.db.batch();

    try {
      await this.wdb.decryptKeys(b, this.wid, key);
    } finally {
      cleanse(key);
    }

    this.save(b);

    await b.write();
  }

  /**
   * Generate a new token.
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async retoken(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._retoken(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Generate a new token without a lock.
   * @private
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async _retoken(passphrase) {
    if (passphrase)
      await this.unlock(passphrase);

    this.tokenDepth += 1;
    this.token = this.getToken(this.tokenDepth);

    const b = this.db.batch();
    this.save(b);

    await b.write();

    return this.token;
  }

  /**
   * Rename the wallet.
   * @param {String} id
   * @returns {Promise}
   */

  async rename(id) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.wdb.rename(this, id);
    } finally {
      unlock();
    }
  }

  /**
   * Rename account.
   * @param {(String|Number)?} acct
   * @param {String} name
   * @returns {Promise}
   */

  async renameAccount(acct, name) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._renameAccount(acct, name);
    } finally {
      unlock();
    }
  }

  /**
   * Rename account without a lock.
   * @private
   * @param {(String|Number)?} acct
   * @param {String} name
   * @returns {Promise}
   */

  async _renameAccount(acct, name) {
    if (!common.isName(name))
      throw new Error('Bad account name.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.accountIndex === 0)
      throw new Error('Cannot rename default account.');

    if (await this.hasAccount(name))
      throw new Error('Account name not available.');

    const b = this.db.batch();

    this.wdb.renameAccount(b, account, name);

    await b.write();
  }

  /**
   * Lock the wallet, destroy decrypted key.
   */

  async lock() {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();
    try {
      await this.master.lock();
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Unlock the key for `timeout` seconds.
   * @param {Buffer|String} passphrase
   * @param {Number?} [timeout=60]
   */

  unlock(passphrase, timeout) {
    return this.master.unlock(passphrase, timeout);
  }

  /**
   * Generate the wallet ID if none was passed in.
   * It is represented as BLAKE2b(m/44->public|magic, 20)
   * converted to an "address" with a prefix
   * of `0x03be04` (`WLT` in base58).
   * @private
   * @returns {Base58String}
   */

  getID() {
    assert(this.master.key, 'Cannot derive id.');

    const key = this.master.key.derive(44);

    const bw = bio.write(37);
    bw.writeBytes(key.publicKey);
    bw.writeU32(this.network.magic);

    const hash = blake2b.digest(bw.render(), 20);

    const b58 = bio.write(23);
    b58.writeU8(0x03);
    b58.writeU8(0xbe);
    b58.writeU8(0x04);
    b58.writeBytes(hash);

    return base58.encode(b58.render());
  }

  /**
   * Generate the wallet api key if none was passed in.
   * It is represented as BLAKE2b(m/44'->private|nonce).
   * @private
   * @param {HDPrivateKey} master
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getToken(nonce) {
    if (!this.master.key)
      throw new Error('Cannot derive token.');

    const key = this.master.key.derive(44, true);

    const bw = bio.write(36);
    bw.writeBytes(key.privateKey);
    bw.writeU32(nonce);

    return blake2b.digest(bw.render());
  }

  /**
   * Create an account. Requires passphrase if master key is encrypted.
   * @param {Object} options - See {@link Account} options.
   * @returns {Promise} - Returns {@link Account}.
   */

  async createAccount(options, passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._createAccount(options, passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Create an account without a lock.
   * @param {Object} options - See {@link Account} options.
   * @returns {Promise} - Returns {@link Account}.
   */

  async _createAccount(options, passphrase) {
    let name = options.name;

    if (!name)
      name = this.accountDepth.toString(10);

    if (await this.hasAccount(name))
      throw new Error('Account already exists.');

    await this.unlock(passphrase);

    let key;
    if (this.watchOnly) {
      key = options.accountKey;

      if (typeof key === 'string')
        key = HD.PublicKey.fromBase58(key, this.network);

      if (!HD.isPublic(key))
        throw new Error('Must add HD public keys to watch only wallet.');
    } else {
      assert(this.master.key);
      const type = this.network.keyPrefix.coinType;
      key = this.master.key.deriveAccount(44, type, this.accountDepth);
      key = key.toPublic();
    }

    const opt = {
      wid: this.wid,
      id: this.id,
      name: this.accountDepth === 0 ? 'default' : name,
      watchOnly: this.watchOnly,
      accountKey: key,
      accountIndex: this.accountDepth,
      type: options.type,
      m: options.m,
      n: options.n,
      keys: options.keys,
      lookahead: options.lookahead,
      staticAddress: options.staticAddress
    };

    const b = this.db.batch();

    const account = Account.fromOptions(this.wdb, opt);

    await account.init(b);

    this.logger.info('Created account %s/%s/%d.',
      account.id,
      account.name,
      account.accountIndex);

    this.accountDepth += 1;
    this.save(b);

    if (this.accountDepth === 1)
      this.increment(b);

    await b.write();

    return account;
  }

  /**
   * Ensure an account. Requires passphrase if master key is encrypted.
   * @param {Object} options - See {@link Account} options.
   * @returns {Promise} - Returns {@link Account}.
   */

  async ensureAccount(options, passphrase) {
    const name = options.name;
    const account = await this.getAccount(name);

    if (account)
      return account;

    return this.createAccount(options, passphrase);
  }

  /**
   * List account names and indexes from the db.
   * @returns {Promise} - Returns Array.
   */

  getAccounts() {
    return this.wdb.getAccounts(this.wid);
  }

  /**
   * Get all wallet address hashes.
   * @param {(String|Number)?} acct
   * @returns {Promise} - Returns Array.
   */

  getAddressHashes(acct) {
    if (acct != null)
      return this.getAccountHashes(acct);
    return this.wdb.getWalletHashes(this.wid);
  }

  /**
   * Get all account address hashes.
   * @param {String|Number} acct
   * @returns {Promise} - Returns Array.
   */

  async getAccountHashes(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    return this.wdb.getAccountHashes(this.wid, index);
  }

  /**
   * Retrieve an account from the database.
   * @param {Number|String} acct
   * @returns {Promise} - Returns {@link Account}.
   */

  async getAccount(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      return null;

    const account = await this.wdb.getAccount(this.wid, index);

    if (!account)
      return null;

    account.wid = this.wid;
    account.id = this.id;
    account.watchOnly = this.watchOnly;

    return account;
  }

  /**
   * Lookup the corresponding account name's index.
   * @param {String|Number} acct - Account name/index.
   * @returns {Promise} - Returns Number.
   */

  getAccountIndex(acct) {
    if (acct == null)
      return -1;

    if (typeof acct === 'number')
      return acct;

    return this.wdb.getAccountIndex(this.wid, acct);
  }

  /**
   * Lookup the corresponding account name's index.
   * @param {String|Number} acct - Account name/index.
   * @returns {Promise} - Returns Number.
   * @throws on non-existent account
   */

  async ensureIndex(acct) {
    if (acct == null || acct === -1)
      return -1;

    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    return index;
  }

  /**
   * Lookup the corresponding account index's name.
   * @param {Number} index - Account index.
   * @returns {Promise} - Returns String.
   */

  async getAccountName(index) {
    if (typeof index === 'string')
      return index;

    return this.wdb.getAccountName(this.wid, index);
  }

  /**
   * Test whether an account exists.
   * @param {Number|String} acct
   * @returns {Promise} - Returns {@link Boolean}.
   */

  async hasAccount(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      return false;

    return this.wdb.hasAccount(this.wid, index);
  }

  /**
   * Get a specific receiving address (does not increment receiveDepth).
   * @param {(Number|String)?} acct
   * @param {Number?} index
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  getReceive(acct = 0, index = 0) {
    return this.getSpecificKey(acct, index, 0);
  }

  /**
   * Get a specific change address (does not increment changeDepth).
   * @param {(Number|String)?} acct
   * @param {Number?} index
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  getChange(acct = 0, index = 0) {
    return this.getSpecificKey(acct, index, 1);
  }

  /**
   * Get a specific address (does not increment depth).
   * @param {(Number|String)?} acct
   * @param {Number} index
   * @param {Number} branch
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  async getSpecificKey(acct, index, branch) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._getSpecificKey(acct, index, branch);
    } finally {
      unlock();
    }
  }

  /**
   * Create a new receiving address (increments receiveDepth).
   * @param {(Number|String)?} acct
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  createReceive(acct = 0) {
    return this.createKey(acct, 0);
  }

  /**
   * Create a new change address (increments receiveDepth).
   * @param {(Number|String)?} acct
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  createChange(acct = 0) {
    return this.createKey(acct, 1);
  }

  /**
   * Create a new address (increments depth).
   * @param {(Number|String)?} acct
   * @param {Number} branch
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  async createKey(acct, branch) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._createKey(acct, branch);
    } finally {
      unlock();
    }
  }

  /**
   * Get a specific address (does not increment depth) without a lock.
   * @private
   * @param {(Number|String)?} acct
   * @param {Number} index
   * @param {Number} branch
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  async _getSpecificKey(acct, index, branch) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.getSpecificKey(index, branch);
  }

  /**
   * Create a new address (increments depth) without a lock.
   * @private
   * @param {(Number|String)?} acct
   * @param {Number} branche
   * @returns {Promise} - Returns {@link WalletKey}.
   */

  async _createKey(acct, branch) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const key = await account.createKey(b, branch);
    await b.write();

    return key;
  }

  /**
   * Save the wallet to the database. Necessary
   * when address depth and keys change.
   * @returns {Promise}
   */

  save(b) {
    return this.wdb.save(b, this);
  }

  /**
   * Increment the wid depth.
   * @returns {Promise}
   */

  increment(b) {
    return this.wdb.increment(b, this.wid);
  }

  /**
   * Test whether the wallet possesses an address.
   * @param {Address|Hash} address
   * @returns {Promise} - Returns Boolean.
   */

  async hasAddress(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);
    return path != null;
  }

  /**
   * Get path by address hash.
   * @param {Address|Hash} address
   * @returns {Promise} - Returns {@link Path}.
   */

  async getPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.getPath(this.wid, hash);
  }

  /**
   * Get path by address hash (without account name).
   * @private
   * @param {Address|Hash} address
   * @returns {Promise} - Returns {@link Path}.
   */

  async readPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.readPath(this.wid, hash);
  }

  /**
   * Test whether the wallet contains a path.
   * @param {Address|Hash} address
   * @returns {Promise} - Returns {Boolean}.
   */

  async hasPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.hasPath(this.wid, hash);
  }

  /**
   * Get all wallet paths.
   * @param {(String|Number)?} acct
   * @returns {Promise} - Returns {@link Path}.
   */

  async getPaths(acct) {
    if (acct != null)
      return this.getAccountPaths(acct);

    return this.wdb.getWalletPaths(this.wid);
  }

  /**
   * Get all account paths.
   * @param {String|Number} acct
   * @returns {Promise} - Returns {@link Path}.
   */

  async getAccountPaths(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    const hashes = await this.getAccountHashes(index);
    const name = await this.getAccountName(acct);

    assert(name);

    const result = [];

    for (const hash of hashes) {
      const path = await this.readPath(hash);

      assert(path);
      assert(path.account === index);

      path.name = name;

      result.push(path);
    }

    return result;
  }

  /**
   * Import a keyring (will not exist on derivation chain).
   * Rescanning must be invoked manually.
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async importKey(acct, ring, passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importKey(acct, ring, passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Import a keyring (will not exist on derivation chain) without a lock.
   * @private
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async _importKey(acct, ring, passphrase) {
    if (!this.watchOnly) {
      if (!ring.privateKey)
        throw new Error('Cannot import pubkey into non watch-only wallet.');
    } else {
      if (ring.privateKey)
        throw new Error('Cannot import privkey into watch-only wallet.');
    }

    const hash = ring.getHash();

    if (await this.getPath(hash))
      throw new Error('Key already exists.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.type !== Account.types.PUBKEYHASH)
      throw new Error('Cannot import into non-pkh account.');

    await this.unlock(passphrase);

    const key = WalletKey.fromRing(account, ring);
    const path = key.toPath();

    if (this.master.encrypted) {
      path.data = this.master.encipher(path.data, path.hash);
      assert(path.data);
      path.encrypted = true;
    }

    const b = this.db.batch();
    await account.savePath(b, path);
    await b.write();
  }

  /**
   * Import a keyring (will not exist on derivation chain).
   * Rescanning must be invoked manually.
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async importAddress(acct, address) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importAddress(acct, address);
    } finally {
      unlock();
    }
  }

  /**
   * Import a keyring (will not exist on derivation chain) without a lock.
   * @private
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async _importAddress(acct, address) {
    if (!this.watchOnly)
      throw new Error('Cannot import address into non watch-only wallet.');

    if (await this.getPath(address))
      throw new Error('Address already exists.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.type !== Account.types.PUBKEYHASH)
      throw new Error('Cannot import into non-pkh account.');

    const path = Path.fromAddress(account, address);

    const b = this.db.batch();
    await account.savePath(b, path);
    await b.write();
  }

  /**
   * Import a name.
   * Rescanning must be invoked manually.
   * @param {String} name
   * @returns {Promise}
   */

  async importName(name) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importName(name);
    } finally {
      unlock();
    }
  }

  /**
   * Import a name without a lock.
   * @private
   * @param {String} name
   * @returns {Promise}
   */

  async _importName(name) {
    const nameHash = rules.hashName(name);

    if (await this.txdb.hasNameState(nameHash))
      throw new Error('Name already exists.');

    const b = this.db.batch();
    await this.wdb.addNameMap(b, nameHash, this.wid);
    await b.write();
  }

  /**
   * Fill a transaction with inputs, estimate
   * transaction size, calculate fee, and add a change output.
   * @see MTX#selectCoins
   * @see MTX#fill
   * @param {MTX} mtx - _Must_ be a mutable transaction.
   * @param {Object?} options
   * @param {(String|Number)?} options.account - If no account is
   * specified, coins from the entire wallet will be filled.
   * @param {String?} options.selection - Coin selection priority. Can
   * be `age`, `random`, or `all`. (default=age).
   * @param {Boolean} options.round - Whether to round to the nearest
   * kilobyte for fee calculation.
   * See {@link TX#getMinFee} vs. {@link TX#getRoundFee}.
   * @param {Rate} options.rate - Rate used for fee calculation.
   * @param {Boolean} options.confirmed - Select only confirmed coins.
   * @param {Boolean} options.free - Do not apply a fee if the
   * transaction priority is high enough to be considered free.
   * @param {Amount?} options.hardFee - Use a hard fee rather than
   * calculating one.
   * @param {Number|Boolean} options.subtractFee - Whether to subtract the
   * fee from existing outputs rather than adding more inputs.
   */

  async fund(mtx, options, force) {
    const unlock1 = await this.fundLock.lock(force);
    const unlock2 = await this.writeLock.lock();
    try {
      return await this.fill(mtx, options);
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Fill a transaction with inputs without a lock.
   * @private
   * @param {MTX} mtx - The mutable transaction to fill
   * @see MTX#selectCoins
   * @see MTX#fill
   */

  async fill(mtx, options) {
    if (!options)
      options = {};

    const acct = options.account || 0;
    const change = await this.changeAddress(acct);

    if (!change)
      throw new Error('Account not found.');

    let rate = options.rate;
    if (rate == null)
      rate = await this.wdb.estimateFee(options.blocks);

    let coins = options.coins || [];
    assert(Array.isArray(coins));
    if (options.smart) {
      const smartCoins = await this.getSmartCoins(options.account);
      coins = coins.concat(smartCoins);
    } else {
      let availableCoins = await this.getCoins(options.account);
      availableCoins = this.txdb.filterLocked(availableCoins);
      coins = coins.concat(availableCoins);
    }

    await mtx.fund(coins, {
      selection: options.selection,
      round: options.round,
      depth: options.depth,
      hardFee: options.hardFee,
      subtractFee: options.subtractFee,
      subtractIndex: options.subtractIndex,
      changeAddress: change,
      height: this.wdb.height,
      coinbaseMaturity: this.network.coinbaseMaturity,
      rate: rate,
      maxFee: options.maxFee,
      estimate: prev => this.estimateSize(prev)
    });

    assert(mtx.getFee() <= MTX.Selector.MAX_FEE, 'TX exceeds MAX_FEE.');
  }

  /**
   * Generate nonce deterministically
   * based on address, name hash, and
   * bid value.
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Buffer}
   */

  async generateNonce(nameHash, address, value) {
    const path = await this.getPath(address.hash);

    if (!path)
      throw new Error('Account not found.');

    const account = await this.getAccount(path.account);

    if (!account)
      throw new Error('Account not found.');

    const hi = (value * (1 / 0x100000000)) >>> 0;
    const lo = value >>> 0;
    const index = (hi ^ lo) & 0x7fffffff;

    const { publicKey } = account.accountKey.derive(index);

    return blake2b.multi(address.hash, publicKey, nameHash);
  }

  /**
   * Generate nonce & blind, save nonce.
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Buffer}
   */

  async generateBlind(nameHash, address, value) {
    const nonce = await this.generateNonce(nameHash, address, value);
    const blind = rules.blind(value, nonce);

    await this.txdb.saveBlind(blind, { value, nonce });

    return blind;
  }

  /**
   * Saves blind into txdb used with restore
   * @param {Number} value value
   * @param {Buffer} nonce nonce
   * @returns {Promise<void>} save result
   */
  saveBlind(value, nonce) {
    const blind = rules.blind(value, nonce);
    return this.txdb.saveBlind(blind, { value, nonce });
  }

  /**
   * Make a claim MTX.
   * @param {String} name
   * @returns {Claim}
   */

  async _createClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');
    assert(options && typeof options === 'object');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = await this.getNameState(nameHash);

    if (ns) {
      if (!ns.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.wdb.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const item = reserved.get(nameHash);
    assert(item);

    let rate = options.rate;
    if (rate == null)
      rate = await this.wdb.estimateFee(options.blocks);

    let size = 5 << 10;
    let vsize = size / consensus.WITNESS_SCALE_FACTOR | 0;
    let proof = null;

    try {
      proof = await ownership.prove(item.target, true);
    } catch (e) {
      ;
    }

    if (proof) {
      const zones = proof.zones;
      const zone = zones.length >= 2
        ? zones[zones.length - 1]
        : null;

      let added = 0;

      // TXT record.
      added += item.target.length; // rrname
      added += 10; // header
      added += 1; // txt size
      added += 200; // max string size

      // RRSIG record size.
      if (!zone || zone.claim.length === 0) {
        added += item.target.length; // rrname
        added += 10; // header
        added += 275; // avg rsa sig size
      }

      const claim = Claim.fromProof(proof);

      size = claim.getSize() + added;

      added /= consensus.WITNESS_SCALE_FACTOR;
      added |= 0;

      vsize = claim.getVirtualSize() + added;
    }

    let minFee = options.fee;

    if (minFee == null)
      minFee = policy.getMinFee(vsize, rate);

    if (this.wdb.height < 1)
      throw new Error('Chain too immature for name claim.');

    let commitHash = (await this.wdb.getBlock(1)).hash;
    let commitHeight = 1;

    if (options.commitHeight != null) {
      const block = await this.wdb.getBlock(options.commitHeight);

      if (!block)
        throw new Error('Block not found.');

      commitHeight = block.height;
      commitHash = block.hash;
    }

    const fee = Math.min(item.value, minFee);
    const acct = options.account || 0;
    const address = await this.receiveAddress(acct);
    const txt = ownership.createData(address,
                                     fee,
                                     commitHash,
                                     commitHeight,
                                     network);

    return {
      name,
      proof,
      target: item.target,
      value: item.value,
      size,
      fee,
      address,
      txt
    };
  }

  /**
   * Create and send a claim MTX.
   * @param {String} name
   * @param {Object} options
   */

  async createClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a claim proof.
   * @param {String} name
   * @param {Object} options
   * @returns {Claim}
   */

  async makeFakeClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = await this.getNameState(nameHash);

    if (ns) {
      if (!ns.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.wdb.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const { proof, txt } = await this._createClaim(name, options);

    if (!proof)
      throw new Error('Could not resolve name.');

    proof.addData([txt]);

    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    return Claim.fromProof(proof);
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async _sendFakeClaim(name, options) {
    const claim = await this.makeFakeClaim(name, options);
    await this.wdb.sendClaim(claim);
    return claim;
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async sendFakeClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendFakeClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a claim proof.
   * @param {String} name
   * @param {Object} options
   * @returns {Claim}
   */

  async makeClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = await this.getNameState(nameHash);

    if (ns) {
      if (!ns.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.wdb.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const item = reserved.get(nameHash);
    assert(item);

    const proof = await ownership.prove(item.target);
    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    return Claim.fromProof(proof);
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async _sendClaim(name, options) {
    const claim = await this.makeClaim(name, options);
    await this.wdb.sendClaim(claim);
    return claim;
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async sendClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a batch open MTX.
   * @param {Array<string>} names
   * @param {Number|String} acct
   * @returns {Promise<Object>}
   */

  async makeBatchOpen(names, acct) {
    assert(Array.isArray(names));
    assert(acct >>> 0 === acct || typeof acct === 'string');

    const errorMessages = [];
    const mtx = new MTX();

    for (const name of names) {
      if (!rules.verifyName(name)) {
        errorMessages.push({ name: name, error: `Invalid name: "${name}".` });
        continue;
      }

      const rawName = Buffer.from(name, 'ascii');
      const nameHash = rules.hashName(rawName);
      const height = this.wdb.height + 1;
      const network = this.network;
      const {icannlockup} = this.wdb.options;

      // TODO: Handle expired behavior.
      if (rules.isReserved(nameHash, height, network)) {
        errorMessages.push({
          name: name,
          error: 'Name is reserved' });
        continue;
      }

      if (icannlockup && rules.isLockedUp(nameHash, height, network)) {
        errorMessages.push({
          name: name,
          error: 'Name is locked up' });
        continue;
      }

      if (!rules.hasRollout(nameHash, height, network)) {
        errorMessages.push({ name: name, error: 'Name not yet available' });
        continue;
      }

      let ns = await this.getNameState(nameHash);
      if (!ns) {
        ns = await this.wdb.getNameStatus(nameHash);
      }

      ns.maybeExpire(height, network);

      const state = ns.state(height, network);
      const start = ns.height;

      if (state !== states.OPENING) {
        errorMessages.push({
          name: name,
          error: `Name is not available: "${name}".`
        });
        continue;
      }

      if (start !== 0 && start !== height) {
        errorMessages.push({
          name: name,
          error: `Name is already opening: "${name}".`
        });
        continue;
      }

      const addr = await this.receiveAddress(acct);

      const output = new Output();
      output.address = addr;
      output.value = 0;
      output.covenant.type = types.OPEN;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(0);
      output.covenant.push(rawName);

      if (await this.txdb.isCovenantDoubleOpen(output.covenant)) {
        errorMessages.push({
          name: name,
          error: `Already sent an open for: ${name}.`
        });
        continue;
      }

      mtx.outputs.push(output);
    }

    const isAllError = (names.length === errorMessages.length);
    return {
      mtx: mtx,
      errors: errorMessages,
      isAllError: isAllError
    };
  }

  /**
   * Create and finalize a batch open
   * MTX without a lock.
   * @param {Array} names
   * @param {Object} options
   * @returns {MTX}
   */

  async _createBatchOpen(names, options) {
    const acct = options ? options.account || 0 : 0;
    const {
      mtx,
      errors,
      isAllError
    } = await this.makeBatchOpen(names, acct);

    if (isAllError) {
      return {
        mtx: null,
        errors: errors,
        isAllError: true
      };
    }

    await this.fill(mtx, options);
    const finalizedMtx = await this.finalize(mtx, options);

    return {
      mtx: finalizedMtx,
      errors: errors,
      isAllError: false
    };
  }

  /**
   * Create and finalize a batch open
   * MTX with a lock.
   * @param {Array} names
   * @param {Object} options
   * @returns {MTX}
   */

  async createBatchOpen(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatchOpen(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a batch open
   * without a lock.
   * @param {Array} names
   * @param {Object} options
   * @returns {Promise<Object>}
   */

  async _sendBatchOpen(names, options) {
    const passphrase = options ? options.passphrase : null;
    const {
      mtx,
      errors,
      isAllError
    } = await this._createBatchOpen(names, options);

    if (isAllError) {
      return {
        tx: null,
        mtx: null,
        errors,
        isAllError
      };
    }

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errors,
      isAllError
    };
  }

  /**
   * Create and send a batch open
   * with a lock.
   * @param {Array} names
   * @param {Object} options
   * @returns {Promise<Object>}
   */

  async sendBatchOpen(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatchOpen(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize an open
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async _createOpen(name, options) {
    const {
      mtx,
      errors,
      isAllError
    } = await this._createBatchOpen(Array.of(name), options);
    if (isAllError) {
      throw new Error(errors[0].error);
    } else {
      return mtx;
    }
  }

  /**
   * Create and finalize an open
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async createOpen(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createOpen(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send an open
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   */

  async _sendOpen(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createOpen(name, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send an open
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   */

  async sendOpen(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendOpen(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Number|String} acct
   * @returns {MTX}
   */

  async makeBid(name, value, lockup, acct) {
    const { mtx } = await this.makeBatchBid([
      { name, value, lockup }
    ], acct);
    return mtx;
  }

  /**
   * Make a bid MTX.
   * @param {Array<BidInfo>} bids
   * @param {Number|String} acct
   * @returns {Promise<BatchResponse>}
   */

  async makeBatchBid(bids, acct) {
    assert((acct >>> 0) === acct || typeof acct === 'string');

    const mtx = new MTX();
    const errorMessages = [];
    let consecutiveCall = false;

    for (const bid of bids) {
      try {
        const { name, value, lockup } = bid;
        const output = await this.processBid(name, value, lockup, acct, consecutiveCall);
        consecutiveCall = true;

        if (bid.idempotencyKey) {
          output['idempotencyKey'] = bid.idempotencyKey;
        }

        mtx.outputs.push(output);
      } catch (err) {
        errorMessages.push({
          ...bid,
          error: err.message
        });
      }
    }

    // to ensure the same behavior for makeBid (single bid)
    if (bids.length === 1 && errorMessages.length === 1) {
      throw new Error(errorMessages[0].error);
    }

    return { mtx, errorMessages };
  }

  /**
   * Process a single bid
   * and create an output
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Number|String} acct
   * @param {Boolean} consecutiveCall
   * @returns {Output}
   */

  async processBid(name, value, lockup, acct, consecutiveCall) {
    assert(typeof name === 'string');
    assert(Number.isSafeInteger(value) && value >= 0);
    assert(Number.isSafeInteger(lockup) && lockup >= 0);

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;
    const {icannlockup} = this.wdb.options;

    if (rules.isReserved(nameHash, height, network))
      throw new Error(`Name is reserved: "${name}".`);

    if (!rules.hasRollout(nameHash, height, network))
      throw new Error(`Name not yet available: "${name}".`);

    if (icannlockup && rules.isLockedUp(nameHash, height, network))
      throw new Error(`Name is locked up: "${name}"`);

    let ns = await this.getNameState(nameHash);

    if (!ns)
      ns = await this.wdb.getNameStatus(nameHash);

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);
    const start = ns.height;

    if (state === states.OPENING)
      throw new Error(`Name has not reached the bidding phase yet: "${name}".`);

    if (state !== states.BIDDING)
      throw new Error(`Name is not available: "${name}".`);

    if (value > lockup)
      throw new Error(`Bid exceeds lockup value: "${name}".`);

    const addr = !consecutiveCall ? await this.receiveAddress(acct)
      : (await this.createReceive(acct)).getAddress();

    const blind = await this.generateBlind(nameHash, addr, value);

    const output = new Output();
    output.address = addr;
    output.value = lockup;
    output.covenant.type = types.BID;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(start);
    output.covenant.push(rawName);
    output.covenant.pushHash(blind);

    return output;
  }

  /**
   * Create batch bid
   * @param {Array} bids
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async createBatchBid(bids, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBid(bids, options);
    } finally {
      unlock();
    }
  }

  /**
   * Send batch bids without lock.
   * @param {Array} bids
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchBid(bids, options) {
    const passphrase = options ? options.passphrase : null;
    const {
      mtx,
      errorMessages
    } = await this._createBid(bids, options);

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errorMessages
    };
  }

  /**
   * Send batch bids with lock.
   * @param {Array} bids
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchBid(bids, options) {
    const unlock = await this.fundLock.lock();

    try {
      return await this._sendBatchBid(bids, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a bid
   * MTX without a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async _createBid(bids, options) {
    const acct = options ? options.account || 0 : 0;
    let { mtx, errorMessages } = await this.makeBatchBid(bids, acct);
    await this.fill(mtx, options);
    mtx = await this.finalize(mtx, options);
    return { mtx, errorMessages };
  }

  /**
   * Create and finalize a bid
   * MTX with a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createBid(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      const { mtx } = await this._createBid([{ name, value, lockup }], options);
      return mtx;
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendBid(name, value, lockup, options) {
    const passphrase = options ? options.passphrase : null;
    const { mtx } = await this._createBid([{ name, value, lockup }], options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendBid(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBid(name, value, lockup, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a bid & a reveal (in advance)
   * MTX with a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Object} output
   * @returns {MTX} output.bid
   * @returns {MTX} output.reveal
   */

  async createAuctionTxs(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createAuctionTxs(name, value, lockup, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a bid & a reveal (in advance)
   * MTX without a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Object} output
   * @returns {MTX} output.bid
   * @returns {MTX} output.reveal
   */

  async _createAuctionTxs(name, value, lockup, options) {
    const { mtx: bid } = await this._createBid([{ name, value, lockup }], options);

    const bidOuputIndex = bid.outputs.findIndex(o => o.covenant.isBid());
    const bidOutput = bid.outputs[bidOuputIndex];
    const bidCoin = Coin.fromTX(bid, bidOuputIndex, -1);

    // Prepare the data needed to make the reveal in advance
    const nameHash = bidOutput.covenant.getHash(0);
    const height = bidOutput.covenant.getU32(1);

    const coins = [];
    coins.push(bidCoin);

    const blind = bidOutput.covenant.getHash(3);
    const bv = await this.getBlind(blind);
    if (!bv)
      throw new Error('Blind value not found.');
    const { nonce } = bv;

    const reveal = new MTX();
    const output = new Output();
    output.address = bidCoin.address;
    output.value = value;
    output.covenant.type = types.REVEAL;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(height);
    output.covenant.pushHash(nonce);
    reveal.addOutpoint(Outpoint.fromTX(bid, bidOuputIndex));
    reveal.outputs.push(output);

    await this.fill(reveal, { ...options, coins: coins });
    assert(
      reveal.inputs.length === 1,
      'Pre-signed REVEAL must not require additional inputs'
    );

    const finalReveal = await this.finalize(reveal, options);
    return { bid, reveal: finalReveal };
  }

  /**
   * Make a reveal MTX.
   * @param {String} name
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeReveal(name, acct) {
    assert(typeof name === 'string');

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const mtx = new MTX();
    const outputs = this.processNameForReveal(name, acct);
    for (const { outpoint, output } of outputs) {
      mtx.addOutpoint(outpoint);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error(`No bids to reveal: "${name}".`);

    return mtx;
  }

  /**
   * Processes a domain name for reveal transaction
   * returns an array of reveal outputs
   * @param {string} domainName
   * @param {number} acct
   * @returns {Promise<OutpointInfo[]>}
   */

  async processNameForReveal(domainName, acct) {
    if (!rules.verifyName(domainName))
      throw new Error(`Invalid name: "${domainName}".`);

    const rawName = Buffer.from(domainName, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${domainName}".`);

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);

    if (state < states.REVEAL)
      throw new Error(`Cannot reveal yet: "${domainName}".`);

    if (state > states.REVEAL)
      throw new Error(`Reveal period has passed: "${domainName}".`);

    const bids = await this.getBids(nameHash);
    const outputs = [];// {outpoint, output}

    for (const { prevout, own } of bids) {
      if (!own)
        continue;

      const { hash, index } = prevout;
      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const blind = coin.covenant.getHash(3);
      const bv = await this.getBlind(blind);

      if (!bv)
        throw new Error(`Blind value not found: "${domainName}".`);

      const { value, nonce } = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.type = types.REVEAL;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);
      output.covenant.pushHash(nonce);

      outputs.push({ outpoint: prevout, output: output });
    }

    return outputs;
  }

  /**
   * Create and send Batch Reveal
   * @param {Array<string>} names
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeBatchReveal(names, acct) {
    assert(Array.isArray(names));

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const errorMessages = [];
    const outputMap = new Map();

    for (const domainName of names) {
      try {
        const outputs = await this.processNameForReveal(domainName, acct);
        if (outputs.length === 0) {
          throw new Error(`No bids to reveal: "${domainName}".`);
        }
        // store results for crafting the mtx
        outputMap.set(domainName, outputs);
      } catch (err) {
        errorMessages.push({ name: domainName, error: err.message });
        continue;
      }
    }

    // to ensure the same behavior for makeReveal (single name)
    if (names.length === 1 && errorMessages.length === 1) {
      throw new Error(errorMessages[0].error);
    }

    // all invalid
    if (outputMap.size === 0) {
      throw new Error('Invalid (Batch) Reveal Request');
    }

    const { validDomains, rejectedDomains } = util
    .createStrictBatch(MAX_REVEALS_PER_BATCH_TX, outputMap);
    const mtx = new MTX();
    for (const { name, bidCount } of validDomains) {
      // create final transaction, consisting of permitted number of bids
      const outputs = outputMap.get(name).slice(0, bidCount);
      for (const { outpoint, output } of outputs) {
        mtx.addOutpoint(outpoint);
        mtx.outputs.push(output);
      }
    }
    for (const { name, bidCount } of rejectedDomains) {
      errorMessages.push({ name: name,
        // eslint-disable-next-line max-len
        error: `Not processing ${name} since it's bidCount of ${bidCount} output size is exceeding allowed cumulative output size` });
    }

    return { mtx, errorMessages };
  }

  /**
   * Create and finalize a reveal
   * MTX without a lock.
   * @param {Array<String>} names
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async _createBatchReveal(names, options) {
    const acct = options ? options.account : null;
    const { mtx, errorMessages } = await this.makeBatchReveal(names, acct);
    await this.fill(mtx, options);
    const finalizedMtx = await this.finalize(mtx, options);
    return { mtx: finalizedMtx, errorMessages: errorMessages };
  }

  /**
   * Create and finalize a batch reveal
   * MTX with a lock.
   * @param {Array<String>} names
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async createBatchReveal(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatchReveal(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a batch reveal
   * without a lock.
   * @param {Array<String>} names
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchReveal(names, options) {
    const passphrase = options ? options.passphrase : null;

    const {
      mtx,
      errorMessages
    } = await this._createBatchReveal(names, options);

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errorMessages
    };
  }

  /**
   * Create and finalize a batch reveal
   * with a lock.
   * @param {Array<String>} names
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchReveal(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatchReveal(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a reveal
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createReveal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      const { mtx } = await this._createBatchReveal([name], options);
      return mtx;
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a reveal MTX.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendReveal(name, options) {
    const passphrase = options ? options.passphrase : null;
    const { mtx } = await this._createBatchReveal([name], options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendReveal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendReveal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a reveal MTX.
   * @returns {Promise<MTX>}
   */

  async makeRevealAll() {
    const height = this.wdb.height + 1;
    const network = this.network;
    const bids = await this.getBids();
    const mtx = new MTX();

    for (const { nameHash, prevout, own } of bids) {
      if (!own)
        continue;

      const ns = await this.getNameState(nameHash);

      if (!ns)
        continue;

      ns.maybeExpire(height, network);

      const state = ns.state(height, network);

      if (state < states.REVEAL)
        continue;

      if (state > states.REVEAL)
        continue;

      const { hash, index } = prevout;
      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const blind = coin.covenant.getHash(3);
      const bv = await this.getBlind(blind);

      if (!bv)
        throw new Error('Blind value not found.');

      const { value, nonce } = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.type = types.REVEAL;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);
      output.covenant.pushHash(nonce);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error('No bids to reveal.');

    return mtx;
  }

  /**
   * Create and finalize a reveal all
   * MTX without a lock.
   * @param {Object} options
   * @returns {MTX}
   */

  async _createRevealAll(options) {
    const mtx = await this.makeRevealAll();
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a reveal all
   * MTX with a lock.
   * @param {Object} options
   * @returns {MTX}
   */

  async createRevealAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRevealAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a reveal all MTX.
   * @param {Object} options
   */

  async _sendRevealAll(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRevealAll(options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {Object} options
   */

  async sendRevealAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRevealAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a redeem MTX.
   * @param {String} name
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeRedeem(name, acct) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const state = ns.state(height, network);

    if (state < states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    const reveals = await this.txdb.getReveals(nameHash);

    const mtx = new MTX();

    for (const { prevout, own } of reveals) {
      const { hash, index } = prevout;

      if (!own)
        continue;

      // Winner can not redeem
      if (prevout.equals(ns.owner))
        continue;

      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error(`No reveals to redeem: "${name}".`);

    return mtx;
  }

  /**
   * Processes Redeems and Registers for provided
   * domain name
   * @param {string} name domain name
   * @param {object} resource resource for REGISTER
   * @param {string|null} acct account
   * @returns {Array<OutpointInfo>} outpoints array
   */
  async processNameForFinish(name, resource, acct) {
    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const state = ns.state(height, network);

    if (state < states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    const reveals = await this.txdb.getReveals(nameHash);
    const outpoints = [];

    for (const { prevout, own } of reveals) {
      const { hash, index } = prevout;

      if (!own)
        continue;

      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);

      if (prevout.equals(ns.owner)) { // Winner, does REGISTER
        output.covenant.type = types.REGISTER;
        // second highest bid
        output.value = ns.value;
        const raw = resource.encode();
        if (raw.length > rules.MAX_RESOURCE_SIZE)
          throw new Error(`Resource exceeds maximum size: "${name}".`);
        output.covenant.push(raw);
        output.covenant.pushHash(await this.wdb.getRenewalBlock());
      }
      outpoints.push({ output: output, outpoint: prevout });
    }

    if (outpoints.length === 0)
      throw new Error(`No reveals to redeem or register: "${name}".`);

    return outpoints;
  }

  /**
   * Make a batch finish MTX.
   * @param {Array<Object>} names
   * @param {(Number|String)} acct
   * @returns {Promise<BatchResponse>}
   */

  async makeBatchFinish(names, acct) {
    assert(Array.isArray(names));

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const mtx = new MTX();
    const errorMessages = [];
    const MAX_FINISH_COUNT = 200;
    let currentLength = 0;

    for (const { name, data: resource } of names) {
      try {
        // Contains Redeems and/or Register
        const finishes = await this.processNameForFinish(name, resource, acct);
        const finishesLength = finishes.length;
        const targetLength = (currentLength + finishesLength);

        if (targetLength > MAX_FINISH_COUNT) {
          throw new Error(`${name} output length ${finishesLength}`
             + 'not enough free slots left within transaction');
        }

        currentLength = targetLength;

        finishes.forEach((element) => {
          const { output, outpoint } = element;
          mtx.addOutpoint(outpoint);
          mtx.outputs.push(output);
        });
      } catch (err) {
        errorMessages.push({ name: name, errorMessage: err.toString() });
      }
    }

    if (mtx.outputs.length === 0)
      throw new Error('No reveals to redeem or register!');

    return { mtx, errorMessages };
  }

  /**
   * Create and finalize a redeem
   * MTX without a lock.
   * @param {Array<String>} name
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async _createBatchFinish(names, options) {
    const acct = options ? options.account : null;
    const { mtx, errorMessages } = await this.makeBatchFinish(names, acct);
    await this.fill(mtx, options);
    const returnObj = {
      mtx: await this.finalize(mtx, options),
      errorMessages: errorMessages
    };
    return returnObj;
  }

  /**
   * Create and finalize a redeem
   * MTX with a lock.
   * @param {Array<Object>} names
   *    - {name: string, data: Object}
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async createBatchFinish(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatchFinish(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a redeem
   * without a lock.
   * @param {Array<Object>} names
   *    - {name: string, data: Object}
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchFinish(names, options) {
    const passphrase = options ? options.passphrase : null;
    const {
      mtx,
      errorMessages
    } = await this._createBatchFinish(names, options);

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errorMessages
    };
  }

  /**
   * Create and finalize a redeem
   * with a lock.
   * @param {Array<Object>} names
   *    - {name: string, data: Object}
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchFinish(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatchFinish(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a redeem
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async _createRedeem(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRedeem(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a redeem
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async createRedeem(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRedeem(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a redeem
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   */

  async _sendRedeem(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRedeem(name, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a redeem
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   */

  async sendRedeem(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRedeem(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a redeem MTX.
   * @param {String} name
   * @returns {MTX}
   */

  async makeRedeemAll() {
    const height = this.wdb.height + 1;
    const network = this.network;
    const reveals = await this.txdb.getReveals();
    const mtx = new MTX();

    for (const { nameHash, prevout, own } of reveals) {
      const { hash, index } = prevout;

      const ns = await this.getNameState(nameHash);

      if (!ns)
        continue;

      if (ns.isExpired(height, network))
        continue;

      const state = ns.state(height, network);

      if (state < states.CLOSED)
        continue;

      if (!own)
        continue;

      if (prevout.equals(ns.owner))
        continue;

      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      mtx.addOutpoint(prevout);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);

      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error('No reveals to redeem.');

    return mtx;
  }

  /**
   * Create and finalize a redeem
   * all MTX without a lock.
   * @param {Object} options
   * @returns {MTX}
   */

  async _createRedeemAll(options) {
    const mtx = await this.makeRedeemAll();
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a redeem
   * all MTX with a lock.
   * @param {Object} options
   * @returns {MTX}
   */

  async createRedeemAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRedeemAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a redeem all
   * MTX without a lock.
   * @param {Object} options
   */

  async _sendRedeemAll(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRedeemAll(options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a redeem all
   * MTX with a lock.
   * @param {Object} options
   */

  async sendRedeemAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRedeemAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a register MTX.
   * @private
   * @param {String} name
   * @param {Resource?} resource
   * @returns {MTX}
   */

  async _makeRegister(name, resource) {
    assert(typeof name === 'string');
    assert(!resource || (resource instanceof Resource));

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet did not win the auction: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet did not win the auction: "${name}".`);

    if (!coin.covenant.isReveal() && !coin.covenant.isClaim())
      throw new Error(`Name must be in REVEAL or CLAIM state: "${name}".`);

    if (coin.covenant.isClaim()) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error(`Claim is not yet mature: "${name}".`);
    }

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = ns.value;

    output.covenant.type = types.REGISTER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    if (resource) {
      const raw = resource.encode();

      if (raw.length > rules.MAX_RESOURCE_SIZE)
        throw new Error(`Resource exceeds maximum size: "${name}".`);

      output.covenant.push(raw);
    } else {
      output.covenant.push(EMPTY);
    }

    output.covenant.pushHash(await this.wdb.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make a raw register MTX.
   * @private
   * @param {String} name
   * @param {String?} resourceHex
   * @param {Number} [acct]
   * @returns {MTX}
   */

  async _makeRawRegister(name, resourceHex, acct) {
    assert(typeof name === 'string');
    assert(!resourceHex || typeof resourceHex === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet did not win the auction: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet did not win the auction: "${name}".`);

    if (!coin.covenant.isReveal() && !coin.covenant.isClaim())
      throw new Error(`Name must be in REVEAL or CLAIM state: "${name}".`);

    if (coin.covenant.isClaim()) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error(`Claim is not yet mature: "${name}".`);
    }

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = ns.value;

    output.covenant.type = types.REGISTER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    if (resourceHex) {
      const raw = Buffer.from(resourceHex, 'hex');

      if (raw.length > rules.MAX_RESOURCE_SIZE)
        throw new Error(`Resource exceeds maximum size: "${name}".`);

      output.covenant.push(raw);
    } else {
      output.covenant.push(EMPTY);
    }

    output.covenant.pushHash(await this.wdb.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make an update MTX.
   * @param {String} name
   * @param {Resource} resource
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeUpdate(name, resource, acct) {
    assert(typeof name === 'string');
    assert(resource instanceof Resource);

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const coin = credit.coin;

    if (coin.covenant.isReveal() || coin.covenant.isClaim())
      return this._makeRegister(name, resource);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name must be registered: "${name}".`);
    }

    const raw = resource.encode();

    if (raw.length > rules.MAX_RESOURCE_SIZE)
      throw new Error(`Resource exceeds maximum size: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(raw);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make a raw update MTX.
   * @param {String} name
   * @param {String} resourceHex
   * @param {Number} [acct]
   * @returns {MTX}
   */

  async makeRawUpdate(name, resourceHex, acct) {
    assert(typeof name === 'string');
    assert(typeof resourceHex === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const coin = credit.coin;

    if (coin.covenant.isReveal() || coin.covenant.isClaim())
      return this._makeRawRegister(name, resourceHex, acct);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name must be registered: "${name}".`);
    }

    const raw = Buffer.from(resourceHex, 'hex');

    if (raw.length > rules.MAX_RESOURCE_SIZE)
      throw new Error(`Resource exceeds maximum size: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(raw);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize an update
   * MTX without a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {MTX}
   */

  async _createUpdate(name, resource, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeUpdate(name, resource, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a raw update
   * MTX without a lock.
   * @param {String} name
   * @param {String} resourceHex
   * @param {Object} options
   * @returns {MTX}
   */

  async _createRawUpdate(name, resourceHex, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRawUpdate(name, resourceHex, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize an update
   * MTX with a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {MTX}
   */

  async createUpdate(name, resource, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createUpdate(name, resource, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a raw update
   * MTX with a lock.
   * @param {String} name
   * @param {String} resourceHex
   * @param {Object} options
   * @returns {MTX}
   */

  async createRawUpdate(name, resourceHex, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRawUpdate(name, resourceHex, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send an update
   * MTX without a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   */

  async _sendUpdate(name, resource, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createUpdate(name, resource, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a raw update
   * MTX without a lock.
   * @param {String} name
   * @param {String} resourceHex
   * @param {Object} options
   */

  async _sendRawUpdate(name, resourceHex, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRawUpdate(name, resourceHex, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send an update
   * MTX with a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   */

  async sendUpdate(name, resource, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendUpdate(name, resource, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a raw update
   * MTX with a lock.
   * @param {String} name
   * @param {String} resourceHex
   * @param {Object} options
   */

  async sendRawUpdate(name, resourceHex, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRawUpdate(name, resourceHex, options);
    } finally {
      unlock();
    }
  }

  /**
  * @typedef {Object} Renewal
  * @property {Output} output
  * @property {Outpoint} outpoint
  */

  /**
  * process a renewal
  * @private
  * @param {String} name
  * @param {Number} acct
  * @returns {Promise<Renewal>}
  */

  async processRenewal(name, acct) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name must be registered: "${name}".`);
    }

    if (height < ns.renewal + network.names.treeInterval)
      throw new Error(`Must wait to renew: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.RENEW;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushHash(await this.wdb.getRenewalBlock());

    return { output, outpoint: ns.owner };
  }

  /**
   * Make a batch renewal MTX.
   * @private
   * @param {String[]} names
   * @param {(Number|String)?} acct
   * @returns {Promise<BatchResponse>}
   */

  async makeBatchRenewal(names, acct) {
    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const errorMessages = [];
    const mtx = new MTX();

    for (const name of names) {
      try {
        const { output, outpoint } = await this.processRenewal(name, acct);
        mtx.addOutpoint(outpoint);
        mtx.outputs.push(output);
      } catch (error) {
        const errorObject = {
          name,
          errorMessage: error.message ? error.message : error.toString()
        };

        errorMessages.push(errorObject);
      }
    }

    return { mtx: mtx, errors: errorMessages };
  }

  /**
   * Create and finalize multiple renewals
   * MTX without a lock.
   * @param {String[]} names
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async _createBatchRenewal(names, options) {
    const acct = options ? options.account : null;
    const {
      mtx: mtxToFillAndFinalize,
      errors
    } = await this.makeBatchRenewal(names, acct);
    await this.fill(mtxToFillAndFinalize, options);
    const mtx = await this.finalize(mtxToFillAndFinalize, options);
    return { mtx, errors };
  }

  /**
   * Create and finalize multiple renewals
   * MTX with a lock
   * @param {String[]} names
   * @param {Object} options
   * @returns {Promise<BatchResponse>}
   */

  async createBatchRenewal(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatchRenewal(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize multiple renewals
   * without lock.
   * @param {String[]} names
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchRenewal(names, options) {
    const passphrase = options ? options.passphrase : null;
    const {mtx, errors} = await this._createBatchRenewal(names, options);

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errors
    };
  }

  /**
   * Create and finalize multiple renewals
   * with lock.
   * @param {String[]} names
   * @param {Object} options
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchRenewal(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatchRenewal(names, options);
    } finally {
      unlock();
    }
  }

  /**
  * Create and finalize a renewal
  * MTX with a lock.
  * @param {String} name
  * @param {Object} options
  * @returns {MTX}
  */

  async createRenewal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      const { mtx, errors } = await this._createBatchRenewal([name], options);

      if (Array.isArray(errors) && errors.length > 0) {
        const [error0] = errors;
        throw new Error(error0.errorMessage);
      }

      return mtx;
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a renewal
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   */

  async _sendRenewal(name, options) {
    const passphrase = options ? options.passphrase : null;
    const { mtx, errors } = await this._createBatchRenewal([name], options);

    if (Array.isArray(errors) && errors.length > 0) {
      const [error0] = errors;
      throw new Error(error0.errorMessage);
    }

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a renewal
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   */

  async sendRenewal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRenewal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer MTX.
   * @param {String} name
   * @param {Address} address
   * @param {(Number|String)?} acct
   * @param {MTX} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeTransfer(name, address, acct, mtx) {
    assert(typeof name === 'string');
    assert(address instanceof Address);

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (coin.covenant.isTransfer())
      throw new Error(`Name is already being transferred: "${name}".`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name must be registered: "${name}".`);
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.TRANSFER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushU8(address.version);
    output.covenant.push(address.hash);

    if (!mtx)
      mtx = new MTX();

    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a transfer
   * MTX without a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createTransfer(name, address, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeTransfer(name, address, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a transfer
   * MTX with a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {MTX}
   */

  async createTransfer(name, address, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createTransfer(name, address, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a transfer
   * MTX without a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   */

  async _sendTransfer(name, address, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createTransfer(
      name,
      address,
      options
    );

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a transfer
   * MTX with a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   */

  async sendTransfer(name, address, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendTransfer(name, address, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a transfer batch
   * without a lock.
   * @param {TransferInfo[]} transfers
   * @param {Object} [options]
   * @returns {Promise<BatchResponse>}
   */

  async _createBatchTransfer(transfers, options) {
    const acct = options ? options.account : null;
    const mtx = new MTX();
    const errors = [];

    assert(Array.isArray(transfers));
    assert(transfers.length > 0);

    for (const {name, address} of transfers) {
      try {
        await this.makeTransfer(name, address, acct, mtx);
      } catch (error) {
        const errorObj = {
          name,
          errorMessage: error.message ? error.message : error.toString()
        };

        errors.push(errorObj);
      }
    }

    if (errors.length === transfers.length)
      return { mtx, errors };

    await this.fill(mtx, options);
    await this.finalize(mtx, options);

    return { mtx, errors };
  }

  /**
   * Create and finalize a transfer batch
   * with a lock.
   * @param {TransferInfo[]} transfers
   * @param {Object} [options]
   * @returns {Promise<BatchResponse>}
   */

  async createBatchTransfer(transfers, options) {
    const unlock = await this.fundLock.lock();

    try {
      return await this._createBatchTransfer(transfers, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send batch transfers
   * without a lock.
   * @param {TransferInfo[]} transfers
   * @param {Object} [options]
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchTransfer(transfers, options) {
    const passphrase = options ? options.passphrase : null;
    const {mtx, errors} = await this._createBatchTransfer(transfers, options);

    if (errors.length === transfers.length) {
      return {
        tx: mtx.toTX(),
        mtx,
        errors
      };
    }

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errors
    };
  }

  /**
   * Create and send batch transfers
   * with a lock.
   * @param {TransferInfo[]} transfers
   * @param {Object} [options]
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchTransfer(transfers, options) {
    const unlock = await this.fundLock.lock();

    try {
      return await this._sendBatchTransfer(transfers, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer-cancelling MTX.
   * @private
   * @param {String} name
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeCancel(name, acct) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const coin = await this.getCoin(hash, index);

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isTransfer())
      throw new Error(`Name is not being transfered: "${name}".`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(EMPTY);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a cancel
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async _createCancel(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeCancel(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a cancel
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async createCancel(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createCancel(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a cancel
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   */

  async _sendCancel(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createCancel(name, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a cancel
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   */

  async sendCancel(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendCancel(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer-finalizing MTX.
   * @private
   * @param {String} name
   * @param {(Number|String)?} acct
   * @param {MTX} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeFinalize(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isTransfer())
      throw new Error(`Name is not being transfered: "${name}".`);

    if (height < coin.height + network.names.transferLockup)
      throw new Error(`Transfer is still locked up: "${name}".`);

    const version = coin.covenant.getU8(2);
    const addr = coin.covenant.get(3);
    const address = Address.fromHash(addr, version);

    let flags = 0;

    if (ns.weak)
      flags |= 1;

    const output = new Output();
    output.address = address;
    output.value = coin.value;
    output.covenant.type = types.FINALIZE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(rawName);
    output.covenant.pushU8(flags);
    output.covenant.pushU32(ns.claimed);
    output.covenant.pushU32(ns.renewals);
    output.covenant.pushHash(await this.wdb.getRenewalBlock());

    if (!mtx)
      mtx = new MTX();

    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a finalize
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createFinalize(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeFinalize(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a finalize
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async createFinalize(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createFinalize(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a finalize
   * MTX without a lock.
   * @param {String} name
   * @param {Object} [options]
   */

  async _sendFinalize(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createFinalize(name, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a finalize
   * MTX with a lock.
   * @param {String} name
   * @param {Object} [options]
   */

  async sendFinalize(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendFinalize(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a finalize batch
   * without a lock.
   * @param {String[]} names
   * @param {Object} [options]
   * @returns {Promise<BatchResponse>}
   */

  async _createBatchFinalize(names, options) {
    const acct = options ? options.account : null;
    const mtx = new MTX();
    const errors = [];

    assert(names.length > 0);
    assert(new Set(names).size === names.length,
      'All names must be unique');

    for (const name of names) {
      try {
        await this.makeFinalize(name, acct, mtx);
      } catch (error) {
        const errorObject = {
          name,
          errorMessage: error.message ? error.message : error.toString()
        };

        errors.push(errorObject);
      }
    }

    if (errors.length === names.length)
      return { mtx, errors };

    await this.fill(mtx, options);
    await this.finalize(mtx, options);

    return { mtx, errors };
  }

  /**
   * Create and finalize a finalize batch
   * with a lock.
   * @param {String[]} names
   * @param {Object} [options]
   * @returns {Promise<BatchResponse>}
   */

  async createBatchFinalize(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatchFinalize(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send batch finalizes
   * without a lock.
   * @param {String[]} names
   * @param {Object} [options]
   * @returns {Promise<BatchSendResponse>}
   */

  async _sendBatchFinalize(names, options) {
    const passphrase = options ? options.passphrase : null;
    const {mtx, errors} = await this._createBatchFinalize(names, options);

    if (errors.length === names.length) {
      return {
        tx: mtx.toTX(),
        mtx,
        errors
      };
    }

    checkAbort(options && options.signal);

    const tx = await this.sendMTX(mtx, passphrase);

    return {
      tx,
      mtx,
      errors
    };
  }

  /**
   * Create and send batch finalizes
   * with a lock.
   * @param {String[]} names
   * @param {Object} [options]
   * @returns {Promise<BatchSendResponse>}
   */

  async sendBatchFinalize(names, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatchFinalize(names, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a revoke MTX.
   * @param {String} name
   * @param {(Number|String)?} acct
   * @returns {MTX}
   */

  async makeRevoke(name, acct) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: "${name}".`);

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acct = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: "${name}".`);

    const { hash, index } = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own: "${name}".`);

    if (acct != null && !await this.txdb.hasCoinByAccount(acct, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: "${name}".`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: "${name}"!`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error(`Auction is not yet closed: "${name}".`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isTransfer()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name must be registered: "${name}".`);
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.REVOKE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a revoke
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async _createRevoke(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRevoke(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a revoke
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {MTX}
   */

  async createRevoke(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRevoke(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a revoke
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   */

  async _sendRevoke(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRevoke(name, options);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a revoke
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   */

  async sendRevoke(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRevoke(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Get account by address.
   * @param {Address} address
   * @returns {Account}
   */

  async getAccountByAddress(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    return this.getAccount(path.account);
  }

  /**
   * Input size estimator for max possible tx size.
   * @param {Address} addr
   * @returns {Number}
   */

  async estimateSize(addr) {
    const account = await this.getAccountByAddress(addr);

    if (!account)
      return -1;

    let size = 0;

    // Varint witness items length.
    size += 1;

    switch (account.type) {
      case Account.types.PUBKEYHASH:
        // P2PKH
        // varint-len [signature]
        size += 1 + 65;
        // varint-len [key]
        size += 1 + 33;
        break;
      case Account.types.MULTISIG:
        // P2SH Multisig
        // OP_0
        size += 1;
        // varint-len [signature] ...
        size += (1 + 65) * account.m;
        // varint-len [redeem]
        size += 3;
        // m value
        size += 1;
        // OP_PUSHDATA0 [key] ...
        size += (1 + 33) * account.n;
        // n value
        size += 1;
        // OP_CHECKMULTISIG
        size += 1;
        break;
    }

    return size;
  }

  /**
   * Build a transaction, fill it with outputs and inputs,
   * sort the members according to BIP69 (set options.sort=false
   * to avoid sorting), set locktime, and template it.
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @returns {Promise} - Returns {@link MTX}.
   */

  async createTX(options, force) {
    const outputs = options.outputs;
    const mtx = new MTX();

    assert(Array.isArray(outputs), 'Outputs must be an array.');
    assert(outputs.length > 0, 'At least one output required.');

    // Add the outputs
    for (const obj of outputs) {
      const output = new Output(obj);
      const addr = output.getAddress();

      if (output.isDust())
        throw new Error('Output is dust.');

      if (output.value > 0) {
        if (!addr)
          throw new Error('Cannot send to unknown address.');

        if (addr.isNull())
          throw new Error('Cannot send to null address.');
      }

      mtx.outputs.push(output);
    }

    // Fill the inputs with unspents
    await this.fund(mtx, options, force);

    return this.finalize(mtx, options);
  }

  /**
   * Finalize and template an MTX.
   * @param {MTX} mtx
   * @param {Object} options
   * @returns {Promsie<MTX>}
   */

  async finalize(mtx, options) {
    if (!options)
      options = {};

    // Sort members a la BIP69
    if (options.sort !== false)
      mtx.sortMembers();

    // Set the locktime to target value.
    if (options.locktime != null)
      mtx.setLocktime(options.locktime);

    // Consensus sanity checks.
    assert(mtx.isSane(), 'TX failed sanity check.');
    assert(mtx.verifyInputs(this.wdb.height + 1, this.network),
      'TX failed context check.');
    assert(this.wdb.height + 1 >= this.network.txStart,
      'Transactions are not allowed on network yet.');

    // Set the HD paths.
    if (options.paths === true)
      mtx.view = await this.getWalletCoinView(mtx, mtx.view);

    const total = await this.template(mtx);

    if (total === 0)
      throw new Error('Templating failed.');

    return mtx;
  }

  /**
   * Build a transaction, fill it with outputs and inputs,
   * sort the members according to BIP69, set locktime,
   * sign and broadcast. Doing this all in one go prevents
   * coins from being double spent.
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @returns {Promise} - Returns {@link TX}.
   */

  async send(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._send(options);
    } finally {
      unlock();
    }
  }

  /**
   * Build and send a transaction without a lock.
   * @private
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @returns {Promise} - Returns {@link TX}.
   */

  async _send(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this.createTX(options, true);

    checkAbort(options && options.signal);

    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Sign and send a (templated) mutable transaction.
   * @param {MTX} mtx
   * @param {String} passphrase
   */

  async sendMTX(mtx, passphrase) {
    await this.sign(mtx, passphrase);

    if (!mtx.isSigned())
      throw new Error('TX could not be fully signed.');

    const tx = mtx.toTX();

    // Policy sanity checks.
    if (tx.getSigops(mtx.view) > policy.MAX_TX_SIGOPS)
      throw new Error('TX exceeds policy sigops.');

    if (tx.getWeight() > policy.MAX_TX_WEIGHT)
      throw new Error('TX exceeds policy weight.');

    const ancestors = await this.getPendingAncestors(tx);
    if (ancestors.size + 1 > this.maxAncestors)
      throw new Error('TX exceeds maximum unconfirmed ancestors.');

    for (const output of tx.outputs) {
      if (output.isDust())
        throw new Error('Output is dust.');

      if (output.value > 0) {
        if (!output.address)
          throw new Error('Cannot send to unknown address.');

        if (output.address.isNull())
          throw new Error('Cannot send to null address.');
      }
    }

    await this.wdb.addTX(tx);

    this.logger.debug('Sending wallet tx (%s): %x', this.id, tx.hash());

    // send to mempool, if succeeds proceed and store
    await this.wdb.send(tx);

    return tx;
  }

  /**
   * Intentionally double-spend outputs by
   * increasing fee for an existing transaction.
   * @param {Hash} hash
   * @param {Rate} rate
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise} - Returns {@link TX}.
   */

  async increaseFee(hash, rate, passphrase) {
    assert((rate >>> 0) === rate, 'Rate must be a number.');

    const wtx = await this.getTX(hash);

    if (!wtx)
      throw new Error('Transaction not found.');

    if (wtx.height !== -1)
      throw new Error('Transaction is confirmed.');

    const tx = wtx.tx;

    if (tx.isCoinbase())
      throw new Error('Transaction is a coinbase.');

    const view = await this.getSpentView(tx);

    if (!tx.hasCoins(view))
      throw new Error('Not all coins available.');

    const oldFee = tx.getFee(view);

    let fee = tx.getMinFee(null, rate);

    if (fee > MTX.Selector.MAX_FEE)
      fee = MTX.Selector.MAX_FEE;

    if (oldFee >= fee)
      throw new Error('Fee is not increasing.');

    const mtx = MTX.fromTX(tx);
    mtx.view = view;

    for (const input of mtx.inputs)
      input.witness.clear();

    let change = null;

    for (let i = 0; i < mtx.outputs.length; i++) {
      const output = mtx.outputs[i];
      const addr = output.getAddress();

      if (!addr)
        continue;

      const path = await this.getPath(addr);

      if (!path)
        continue;

      if (path.branch === 1) {
        change = output;
        mtx.changeIndex = i;
        break;
      }
    }

    if (!change)
      throw new Error('No change output.');

    change.value += oldFee;

    if (mtx.getFee() !== 0)
      throw new Error('Arithmetic error for change.');

    change.value -= fee;

    if (change.value < 0)
      throw new Error('Fee is too high.');

    if (change.isDust()) {
      mtx.outputs.splice(mtx.changeIndex, 1);
      mtx.changeIndex = -1;
    }

    await this.sign(mtx, passphrase);

    if (!mtx.isSigned())
      throw new Error('TX could not be fully signed.');

    const ntx = mtx.toTX();

    this.logger.debug(
      'Increasing fee for wallet tx (%s): %x',
      this.id, ntx.hash());

    await this.wdb.addTX(ntx);
    await this.wdb.send(ntx);

    return ntx;
  }

  /**
   * Resend pending wallet transactions.
   * @returns {Promise}
   */

  async resend() {
    const wtxs = await this.getPending();

    if (wtxs.length > 0)
      this.logger.info('Rebroadcasting %d transactions.', wtxs.length);

    const txs = [];

    for (const wtx of wtxs) {
      if (!wtx.tx.isCoinbase())
        txs.push(wtx.tx);
    }

    const sorted = common.sortDeps(txs);

    for (const tx of sorted)
      await this.wdb.send(tx);

    return txs;
  }

  /**
   * Derive necessary addresses for signing a transaction.
   * @param {MTX} mtx
   * @param {Number?} index - Input index.
   * @returns {Promise} - Returns {@link WalletKey}[].
   */

  async deriveInputs(mtx) {
    assert(mtx.mutable);

    const paths = await this.getInputPaths(mtx);
    const rings = [];

    for (const path of paths) {
      const account = await this.getAccount(path.account);

      if (!account)
        continue;

      const ring = account.derivePath(path, this.master);

      if (ring)
        rings.push(ring);
    }

    return rings;
  }

  /**
   * Retrieve a single keyring by address.
   * @param {Address|Hash} hash
   * @returns {Promise}
   */

  async getKey(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    const account = await this.getAccount(path.account);

    if (!account)
      return null;

    // The account index in the db may be wrong.
    // We must read it from the stored xpub to be
    // sure of its correctness.
    //
    // For more details see:
    // https://github.com/bcoin-org/bcoin/issues/698.
    //
    // TODO(boymanjor): remove index manipulation
    // once the watch-only wallet bug is fixed.
    account.accountIndex = account.accountKey.childIndex;

    // Unharden the account index, if necessary.
    if (account.accountIndex & HD.common.HARDENED)
      account.accountIndex ^= HD.common.HARDENED;

    return account.derivePath(path, this.master);
  }

  /**
   * Retrieve a single keyring by address
   * (with the private key reference).
   * @param {Address|Hash} hash
   * @param {(Buffer|String)?} passphrase
   * @returns {Promise}
   */

  async getPrivateKey(address, passphrase) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    const account = await this.getAccount(path.account);

    if (!account)
      return null;

    await this.unlock(passphrase);

    const key = account.derivePath(path, this.master);

    if (!key.privateKey)
      return null;

    return key;
  }

  /**
   * Map input addresses to paths.
   * @param {MTX} mtx
   * @returns {Promise} - Returns {@link Path}[].
   */

  async getInputPaths(mtx) {
    assert(mtx.mutable);

    if (!mtx.hasCoins())
      throw new Error('Not all coins available.');

    const hashes = mtx.getInputHashes();
    const paths = [];

    for (const hash of hashes) {
      const path = await this.getPath(hash);
      if (path)
        paths.push(path);
    }

    return paths;
  }

  /**
   * Map output addresses to paths.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link Path}[].
   */

  async getOutputPaths(tx) {
    const paths = [];
    const hashes = tx.getOutputHashes();

    for (const hash of hashes) {
      const path = await this.getPath(hash);
      if (path)
        paths.push(path);
    }

    return paths;
  }

  /**
   * Increase lookahead for account.
   * @param {(Number|String)?} account
   * @param {Number} lookahead
   * @returns {Promise}
   */

  async setLookahead(acct, lookahead) {
    const unlock = await this.writeLock.lock();
    try {
      return this._setLookahead(acct, lookahead);
    } finally {
      unlock();
    }
  }

  /**
   * Increase lookahead for account (without a lock).
   * @private
   * @param {(Number|String)?} account
   * @param {Number} lookahead
   * @returns {Promise}
   */

  async _setLookahead(acct, lookahead) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    await account.setLookahead(b, lookahead);
    await b.write();
  }

  /**
   * Sync address depths based on a transaction's outputs.
   * This is used for deriving new addresses when
   * a confirmed transaction is seen.
   * @param {TX} tx
   * @returns {Promise}
   */

  async syncOutputDepth(tx) {
    const map = new Map();

    for (const hash of tx.getOutputHashes()) {
      const path = await this.readPath(hash);

      if (!path)
        continue;

      if (path.index === -1)
        continue;

      if (!map.has(path.account))
        map.set(path.account, []);

      map.get(path.account).push(path);
    }

    const derived = [];
    const b = this.db.batch();

    for (const [acct, paths] of map) {
      let receive = -1;
      let change = -1;

      for (const path of paths) {
        switch (path.branch) {
          case 0:
            if (path.index > receive)
              receive = path.index;
            break;
          case 1:
            if (path.index > change)
              change = path.index;
            break;
        }
      }

      receive += 2;
      change += 2;

      const account = await this.getAccount(acct);
      assert(account);

      const ring = await account.syncDepth(b, receive, change);

      if (ring)
        derived.push(ring);
    }

    await b.write();

    return derived;
  }

  /**
   * Build input scripts templates for a transaction (does not
   * sign, only creates signature slots). Only builds scripts
   * for inputs that are redeemable by this wallet.
   * @param {MTX} mtx
   * @returns {Promise} - Returns Number
   * (total number of scripts built).
   */

  async template(mtx) {
    const rings = await this.deriveInputs(mtx);
    return mtx.template(rings);
  }

  /**
   * Build input scripts and sign inputs for a transaction. Only attempts
   * to build/sign inputs that are redeemable by this wallet.
   * @param {MTX} tx
   * @param {Object|String|Buffer} options - Options or passphrase.
   * @returns {Promise} - Returns Number (total number
   * of inputs scripts built and signed).
   */

  async sign(mtx, passphrase) {
    if (this.watchOnly)
      throw new Error('Cannot sign from a watch-only wallet.');

    await this.unlock(passphrase);

    const rings = await this.deriveInputs(mtx);

    return mtx.signAsync(rings, Script.hashType.ALL, this.wdb.workers);
  }

  /**
   * Get pending ancestors up to the policy limit
   * @param {TX} tx
   * @returns {Promise} - Returns {BufferSet} with Hash
   */

  async getPendingAncestors(tx) {
    return this._getPendingAncestors(tx, new BufferSet());
  }

  /**
   * Get pending ancestors up to the policy limit.
   * @param {TX} tx
   * @param {Object} set
   * @returns {Promise} - Returns {BufferSet} with Hash
   */

  async _getPendingAncestors(tx, set) {
    for (const { prevout } of tx.inputs) {
      const hash = prevout.hash;

      if (set.has(hash))
        continue;

      if (!await this.hasPending(hash))
        continue;

      set.add(hash);

      if (set.size > this.maxAncestors)
        break;

      const parent = await this.getTX(hash);
      await this._getPendingAncestors(parent.tx, set);

      if (set.size > this.maxAncestors)
        break;
    }

    return set;
  }

  /**
   * Test whether the database has a pending transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasPending(hash) {
    return this.txdb.hasPending(hash);
  }

  /**
   * Get a coin viewpoint.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getCoinView(tx) {
    return this.txdb.getCoinView(tx);
  }

  /**
   * Get a wallet coin viewpoint with HD paths.
   * @param {TX} tx
   * @param {CoinView?} view - Coins to be used in wallet coin viewpoint.
   * @returns {Promise} - Returns {@link WalletCoinView}.
   */

  async getWalletCoinView(tx, view) {
    if (!(view instanceof CoinView))
      view = new CoinView();

    if (!tx.hasCoins(view))
      view = await this.txdb.getCoinView(tx);

    view = WalletCoinView.fromCoinView(view);

    for (const input of tx.inputs) {
      const prevout = input.prevout;
      const coin = view.getCoin(prevout);

      if (!coin)
        continue;

      const path = await this.getPath(coin.address);

      if (!path)
        continue;

      const account = await this.getAccount(path.account);

      if (!account)
        continue;

      // The account index in the db may be wrong.
      // We must read it from the stored xpub to be
      // sure of its correctness.
      //
      // For more details see:
      // https://github.com/bcoin-org/bcoin/issues/698.
      //
      // TODO(boymanjor): remove index manipulation
      // once the watch-only wallet bug is fixed.
      path.account = account.accountKey.childIndex;

      // Unharden the account index, if necessary.
      if (path.account & HD.common.HARDENED)
        path.account ^= HD.common.HARDENED;

      // Add path to the viewpoint.
      view.addPath(prevout, path);
    }

    return view;
  }

  /**
   * Get a historical coin viewpoint.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getSpentView(tx) {
    return this.txdb.getSpentView(tx);
  }

  /**
   * Convert transaction to transaction details.
   * @param {TXRecord} wtx
   * @returns {Promise<Details>} - Returns {@link Details}.
   */

  toDetails(wtx) {
    return this.txdb.toDetails(wtx);
  }

  /**
   * Get transaction details.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Details}.
   */

  getDetails(hash) {
    return this.txdb.getDetails(hash);
  }

  /**
   * Get a coin from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  getCoin(hash, index) {
    return this.txdb.getCoin(hash, index);
  }

  /**
   * Get an unspent coin from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  async getUnspentCoin(hash, index) {
    const credit = await this.txdb.getCredit(hash, index);

    if (!credit || credit.spent)
      return null;

    return credit.coin;
  }

  /**
   * Get credit from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Credit>}
   */

  getCredit(hash, index) {
    return this.txdb.getCredit(hash, index);
  }

  /**
   * Get a transaction from the wallet.
   * @param {Hash} hash
   * @returns {Promise<TX>?} - Returns {@link TX}.
   */

  getTX(hash) {
    return this.txdb.getTX(hash);
  }

  /**
   * List blocks for the wallet.
   * @returns {Promise} - Returns {@link BlockRecord}.
   */

  getBlocks() {
    return this.txdb.getBlocks();
  }

  /**
   * Get a block from the wallet.
   * @param {Number} height
   * @returns {Promise} - Returns {@link BlockRecord}.
   */

  getBlock(height) {
    return this.txdb.getBlock(height);
  }

  /**
   * Get all names.
   * @returns {NameState[]}
   */

  async getNames() {
    return this.txdb.getNames();
  }

  /**
   * Get a name if present.
   * @param {Buffer} nameHash
   * @returns {Promise<NameState>}
   */

  async getNameState(nameHash) {
    return this.txdb.getNameState(nameHash);
  }

  /**
   * Get a name if present.
   * @param {String|Buffer} name
   * @returns {NameState}
   */

  async getNameStateByName(name) {
    return this.txdb.getNameState(rules.hashName(name));
  }

  /**
   * Get a blind value if present.
   * @param {Buffer} blind - Blind hash.
   * @returns {BlindValue}
   */

  async getBlind(blind) {
    return this.txdb.getBlind(blind);
  }

  /**
   * Get all bids for name.
   * @param {Buffer} nameHash
   * @returns {BlindBid[]}
   */

  async getBids(nameHash) {
    return this.txdb.getBids(nameHash);
  }

  /**
   * Get all bids for name.
   * @param {String|Buffer} name
   * @returns {BlindBid[]}
   */

  async getBidsByName(name) {
    return this.txdb.getBids(name ? rules.hashName(name) : null);
  }

  /**
   * Get all reveals by name.
   * @param {Buffer} nameHash
   * @returns {BidReveal[]}
   */

  async getReveals(nameHash) {
    return this.txdb.getReveals(nameHash);
  }

  /**
   * Get all reveals by name.
   * @param {String} name
   * @returns {BidReveal[]}
   */

  async getRevealsByName(name) {
    return this.txdb.getReveals(name ? rules.hashName(name) : null);
  }

  /**
   * Add a transaction to the wallets TX history.
   * @param {TX} tx
   * @returns {Promise}
   */

  async add(tx, block) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._add(tx, block);
    } finally {
      unlock();
    }
  }

  /**
   * Add a transaction to the wallet without a lock.
   * Potentially resolves orphans.
   * @private
   * @param {TX} tx
   * @returns {Promise}
   */

  async _add(tx, block) {
    const details = await this.txdb.add(tx, block);
    let derived = [];

    if (details) {
      derived = await this.syncOutputDepth(tx);
      if (derived.length > 0) {
        this.wdb.emit('address', this, derived);
        this.emit('address', derived);
      }
    }

    return {details, derived};
  }

  /**
   * Revert a block.
   * @param {Number} height
   * @returns {Promise}
   */

  async revert(height) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.txdb.revert(height);
    } finally {
      unlock();
    }
  }

  /**
   * Remove a wallet transaction.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async remove(hash) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.txdb.remove(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Zap stale TXs from wallet.
   * @param {(Number|String)?} acct
   * @param {Number} age - Age threshold (unix time, default=72 hours).
   * @returns {Promise}
   */

  async zap(acct, age) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._zap(acct, age);
    } finally {
      unlock();
    }
  }

  /**
   * Zap stale TXs from wallet without a lock.
   * @private
   * @param {(Number|String)?} acct
   * @param {Number} age
   * @returns {Promise}
   */

  async _zap(acct, age) {
    const account = await this.ensureIndex(acct);
    return this.txdb.zap(account, age);
  }

  /**
   * Abandon transaction.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async abandon(hash) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._abandon(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Abandon transaction without a lock.
   * @private
   * @param {Hash} hash
   * @returns {Promise}
   */

  _abandon(hash) {
    return this.txdb.abandon(hash);
  }

  /**
   * Lock a single coin.
   * @param {Coin|Outpoint} coin
   */

  lockCoin(coin) {
    return this.txdb.lockCoin(coin);
  }

  /**
   * Unlock a single coin.
   * @param {Coin|Outpoint} coin
   */

  unlockCoin(coin) {
    return this.txdb.unlockCoin(coin);
  }

  /**
   * Unlock all locked coins.
   */

  unlockCoins() {
    return this.txdb.unlockCoins();
  }

  /**
   * Test locked status of a single coin.
   * @param {Coin|Outpoint} coin
   * @returns {Boolean}
   */

  isLocked(coin) {
    return this.txdb.isLocked(coin);
  }

  /**
   * Return an array of all locked outpoints.
   * @returns {Outpoint[]}
   */

  getLocked() {
    return this.txdb.getLocked();
  }

  /**
   * Get all transactions in transaction history.
   * @param {(String|Number)?} acct
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getHistory(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getHistory(account);
  }

  /**
   * Get all available coins.
   * @param {(String|Number)?} account
   * @returns {Promise<Array<Coin>>} - Returns {@link Coin}[].
   */

  async getCoins(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getCoins(account);
  }

  /**
   * Get all available credits.
   * @param {(String|Number)?} account
   * @returns {Promise} - Returns {@link Credit}[].
   */

  async getCredits(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getCredits(account);
  }

  /**
   * Get "smart" coins.
   * @param {(String|Number)?} account
   * @returns {Promise} - Returns {@link Coin}[].
   */

  async getSmartCoins(acct) {
    const credits = await this.getCredits(acct);
    const coins = [];

    for (const credit of credits) {
      const coin = credit.coin;

      if (credit.spent)
        continue;

      if (this.txdb.isLocked(coin))
        continue;

      // Always used confirmed coins.
      if (coin.height !== -1) {
        coins.push(coin);
        continue;
      }

      // Use unconfirmed only if they were
      // created as a result of one of our
      // _own_ transactions. i.e. they're
      // not low-fee and not in danger of
      // being double-spent by a bad actor.
      if (!credit.own)
        continue;

      coins.push(coin);
    }

    return coins;
  }

  /**
   * Get all pending/unconfirmed transactions.
   * @param {(String|Number)?} acct
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getPending(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getPending(account);
  }

  /**
   * Get all pending/unconfirmed transactions.
   * @param {(String|Number)?} acct
   * @param {Number} age
   * @returns {Promise<String[]>} - Returns {@link TX}[].
   */

  async getPendingTxHashes(acct, age) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getPendingTxHashes(account, age);
  }

  /**
   * Get wallet balance.
   * @param {(String|Number)?} acct
   * @returns {Promise} - Returns {@link Balance}.
   */

  async getBalance(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getBalance(account);
  }

  /**
   * Get a range of transactions between two timestamps.
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Number} options.start
   * @param {Number} options.end
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getRange(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getRange(account, options);
  }

  /**
   * Get the last N transactions.
   * @param {(String|Number)?} acct
   * @param {Number} limit
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getLast(acct, limit) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getLast(account, limit);
  }

  /**
   * Get account key.
   * @param {Number} [acct=0]
   * @returns {HDPublicKey}
   */

  async accountKey(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.accountKey;
  }

  /**
   * Resave already-generated keys that should have already be saved.
   * @param {Number} [acct=0]
   * @param {Number} receiveDepth
   * @param {Number} changeDepth
   * @returns {Promise}
   */

  async resyncDepth(acct = 0, receiveDepth, changeDepth) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    await account.resyncDepth(b, receiveDepth, changeDepth);
    await b.write();
  }

  /**
   * Get current receive depth.
   * @param {Number} [acct=0]
   * @returns {Number}
   */

  async receiveDepth(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.receiveDepth;
  }

  /**
   * Get current change depth.
   * @param {Number} [acct=0]
   * @returns {Number}
   */

  async changeDepth(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.changeDepth;
  }

  /**
   * Get current receive address.
   * @param {Number} [acct=0]
   * @returns {Address}
   */

  async receiveAddress(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.receiveAddress();
  }

  /**
   * Get current change address.
   * @param {Number} [acct=0]
   * @returns {Address}
   */

  async changeAddress(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.changeAddress();
  }

  /**
   * Get current receive key.
   * @param {Number} [acct=0]
   * @returns {WalletKey}
   */

  async receiveKey(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.receiveKey();
  }

  /**
   * Get current change key.
   * @param {Number} [acct=0]
   * @returns {WalletKey}
   */

  async changeKey(acct = 0) {
    const account = await this.getAccount(acct);
    if (!account)
      throw new Error('Account not found.');
    return account.changeKey();
  }

  /**
   * Convert the wallet to a more inspection-friendly object.
   * @returns {Object}
   */

  format() {
    return {
      wid: this.wid,
      id: this.id,
      network: this.network.type,
      accountDepth: this.accountDepth,
      token: this.token.toString('hex'),
      tokenDepth: this.tokenDepth,
      master: this.master
    };
  }

  /**
   * Convert the wallet to a more inspection-friendly object.
   * @returns {Object}
   */

  inspect() {
    return this.format();
  }

  /**
   * Convert the wallet to an object suitable for
   * serialization.
   * @param {Boolean?} unsafe - Whether to include
   * the master key in the JSON.
   * @returns {Object}
   */

  getJSON(unsafe, balance) {
    return {
      network: this.network.type,
      wid: this.wid,
      id: this.id,
      watchOnly: this.watchOnly,
      accountDepth: this.accountDepth,
      token: this.token.toString('hex'),
      tokenDepth: this.tokenDepth,
      master: this.master.getJSON(this.network, unsafe),
      balance: balance ? balance.toJSON(true) : null
    };
  }

  /**
   * Retrieves all blinds for this wallet
   * @returns {Promise<BlindValue[]>} BlindValues
   */
  getBlinds() {
    return this.txdb.getBlinds();
  }

  /**
   * Convert the wallet to an object suitable for
   * serialization.
   * @param {Boolean?} unsafe - Whether to include
   * the master key in the JSON.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
  }

  /**
   * Calculate serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += 41;
    size += this.master.getSize();
    return size;
  }

  /**
   * Serialize the wallet.
   * @returns {Buffer}
   */

  encode() {
    const size = this.getSize();
    const bw = bio.write(size);

    let flags = 0;

    if (this.watchOnly)
      flags |= 1;

    bw.writeU8(flags);
    bw.writeU32(this.accountDepth);
    bw.writeBytes(this.token);
    bw.writeU32(this.tokenDepth);
    this.master.write(bw);

    return bw.render();
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  decode(data) {
    const br = bio.read(data);

    const flags = br.readU8();

    this.watchOnly = (flags & 1) !== 0;
    this.accountDepth = br.readU32();
    this.token = br.readBytes(32);
    this.tokenDepth = br.readU32();
    this.master.read(br);

    return this;
  }

  /**
   * Instantiate a wallet from serialized data.
   * @param {Buffer} data
   * @returns {Wallet}
   */

  static decode(wdb, data) {
    return new this(wdb).decode(data);
  }

  /**
   * Test an object to see if it is a Wallet.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isWallet(obj) {
    return obj instanceof Wallet;
  }
}

/*
 * Helpers
 */

function checkAbort(signal) {
  if (!signal)
    return;

  if (signal.aborted)
    throw new common.AbortError('Operation was aborted');
}

/*
 * Expose
 */

module.exports = Wallet;

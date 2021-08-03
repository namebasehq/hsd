/* eslint-disable max-len */
// @ts-check

/*!
 * cachedtxdb.js - persistent transaction pool with in-memory cache
 * Copyright (c) 2021, Namebase Inc (MIT Licence).
 * https://github.com/namebasehq/hsd
 */

'use strict';

const assert = require('bsert');
const TXDB = require('./txdb');
const Outpoint = require('../primitives/outpoint');

/** @typedef {import('./walletdb')} WalletDB */
/** @typedef {import('./txdb').Credit} Credit */
/** @typedef {import('./wallet')} Wallet')} */
/** @typedef {import('./path')} Path} */

/**
 *
 * @template K key
 * @template V value
 * @param {Map<K, V>} parent containing map
 * @param {K} key the key to get or create
 * @param {function(): V} makeNew a function to produce a new value if
 *                                the map doesn't contain it
 * @returns {V} the value from the map
 */
function getOrCreate(parent, key, makeNew) {
  if (parent.has(key)) {
    return parent.get(key);
  }

  const newVal = makeNew();
  parent.set(key, newVal);

  return newVal;
}

/**
 * @template K1, K2, V
 * @param {Map<K1, Map<K2, V>>} parent x
 * @param {K1} key  x
 * @returns {Map<K2,V>} x
 */
function ensureMap(parent, key) {
  return getOrCreate(parent, key, () => new Map());
}

const BatchOps = {
  PutCredit: 0,
  PutCoinByAddress: 1,
  DelCredit: 2,
  DelCoinByAddress: 3
};

class CachedBatch {
  /**
   * @param {any} bdbBatch bdb batch
   * @param {CachedTXDB} cachedTxdb the txdb to update eventually
   */
  constructor(bdbBatch, cachedTxdb) {
    this.bdbBatch = bdbBatch;

    /** @type {CachedTXDB} */
    this.txdb = cachedTxdb;
    /** @type {Array<[number, string, number, Credit?] | [number, number, string, number] >} */
    this.ops = [];
  }

  /**
   * @param {Credit} credit a credit to add
   * @param {Number} accountId the account to add it to
   * @returns {void}
   */
  insertCredit(credit, accountId) {
    const hashHex = credit.coin.hash.toString('hex');
    this.ops.push([BatchOps.PutCredit, hashHex, credit.coin.index, credit]);
    this.ops.push([BatchOps.PutCoinByAddress, accountId, hashHex, credit.coin.index]);
  }

  /**
   * @param {Credit} credit a credit to remove
   * @param {Number} accountId the account to remove it from
   * @returns {void}
   */
  removeCredit(credit, accountId) {
    const { coin } = credit;
    const hashHex = coin.hash.toString('hex');
    this.ops.push([BatchOps.DelCredit, hashHex, coin.index]);
    this.ops.push([BatchOps.DelCoinByAddress, accountId, hashHex, coin.index]);
  }

  async write() {
    await this.bdbBatch.write();
    /** @type { string } */
    let hashHex;
    /** @type { number } */
    let index;
    /** @type { Credit } */
    let credit;
    /** @type { number } */
    let accountId;
    /** @type { number } */
    let _;

    for (const op of this.ops) {
      _ = op[0];
      switch (_) {
        case BatchOps.PutCredit:
          // @ts-ignore
          [_, hashHex, index, credit] = op;
          ensureMap(this.txdb.cachedCredits, hashHex).set(index, credit);
          break;
        case BatchOps.PutCoinByAddress:
          // @ts-ignore
          [_, accountId, hashHex, index] = op;
          getOrCreate(
            ensureMap(this.txdb.cachedCoinsByAddress, accountId),
            hashHex,
            () => new Set()
          ).add(index);
          break;
        case BatchOps.DelCredit:
          // @ts-ignore
          [_, hashHex, index] = op;
          ensureMap(this.txdb.cachedCredits, hashHex).delete(index);
          break;
        case BatchOps.DelCoinByAddress:
          // @ts-ignore
          [_, accountId, hashHex, index] = op;
          getOrCreate(
            ensureMap(this.txdb.cachedCoinsByAddress, accountId),
            hashHex,
            () => new Set()
          ).delete(index);
          break;
      }
    }
  }
}

class CachedTXDB extends TXDB {
  /**
   * Create a TXDB with in-memory cache for coin selection
   * @param {WalletDB} wdb wallet database
   * @param {string | number} wid wallet id
   */
  constructor(wdb, wid) {
    super(wdb, wid);

    /** @type {Map<string, Map<number, Credit>>} */
    this.cachedCredits = new Map();

    /** @type {Map<number, Map<string, Set<number>>>} */
    this.cachedCoinsByAddress = new Map();
  }

  /**
   * @returns {CachedBatch} a cached batch which proxies a bdb batch
   */
  newBatch() {
    const bdbBatch = super.newBatch();
    const cachedBatch = new CachedBatch(bdbBatch, this);

    return new Proxy(cachedBatch, {
      get: (target, key) =>
        target[key] || bdbBatch[key] || undefined
    });
  }

  async _loadCredits() {
    const allCredits = await super.getCredits(-1);
    const b = this.newBatch();

    for (const credit of allCredits) {
      b.insertCredit(credit, (await this.getPath(credit.coin)).account);
    }

    b.write();
  }

  /**
   *
   * @param {Wallet} wallet a wallet
   * @returns {Promise<any>} ???
   */
  async open(wallet) {
    const result = await super.open(wallet);
    await this._loadCredits();

    return result;
  }

  /**
   * Save credit.
   * @param {CachedBatch} b cached batch
   * @param {Credit} credit the credit to save
   * @param {Path} path the path to save at
   * @returns {Promise<any>} ???
   */
  async saveCredit(b, credit, path) {
    b.insertCredit(credit, path.account);
    return await super.saveCredit(b, credit, path);
  }

  /**
   * Remove credit.
   * @param {CachedBatch} b cached batch
   * @param {Credit} credit credit to remove
   * @param {Path} path path to remove at
   * @returns {Promise<any>} ???
   */
  async removeCredit(b, credit, path) {
    b.removeCredit(credit, path.account);
    return await super.removeCredit(b, credit, path);
  }

  /**
   * Get coins.
   * @param {number} acct account id
   * @returns {Promise<Credit[]>} - Returns {@link Credit}[].
   */
  async getCredits(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1) {
      return await this.getAccountCredits(acct);
    }

    return [...this.cachedCredits].flatMap(
      ([_, inner]) => [...inner].map(
        (([_, credit]) => credit)
      )
    );
  }

  /**
   * Get coin.
   * @param {Buffer} hash transaction hash
   * @param {number} index transaction index
   * @returns {Promise<Credit | null>} - Returns {@link Credit}.
   */
  async getCredit(hash, index) {
    const hashHex = hash.toString('hex');
    const innerMap = this.cachedCredits.get(hashHex);
    if (!innerMap) {
      return null;
    }

    return innerMap.get(index) || null;
  }

  /**
   * Get all outpoints from memory.
   * @param {number} acct the account id number
   * @returns {Promise<Outpoint[]>} - Returns {@link Outpoint}[].
   */
  async getOutpoints(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountOutpoints(acct);

    return [...this.cachedCredits].flatMap(
      ([hash, inner]) => [...inner].map(
        (([index, credit]) => credit ? new Outpoint(Buffer.from(hash, 'hex'), index) : null)
      ).filter(x => x !== null)
    );
  }

  /**
   * Get all outpoints for an account.
   * @param {number} acct the account id
   * @returns {Promise<Outpoint[]>} - Returns {@link Outpoint}[].
   */
  async getAccountOutpoints(acct) {
    assert(typeof acct === 'number');
    if (!this.cachedCoinsByAddress.has(acct)) {
      return [];
    }

    return [...this.cachedCoinsByAddress.get(acct)].flatMap(
      ([hash, inner]) => [...inner].map(
        (index => new Outpoint(Buffer.from(hash, 'hex'), index))
      )
    );
  }

  /**
   * Test whether the cache has a transaction.
   * @param {Buffer} hash tx hash
   * @param {number} index tx index
   * @returns {Promise<boolean>} - Returns Boolean.
   */
  async hasCoin(hash, index) {
    return ensureMap(this.cachedCredits, hash.toString('hex')).has(index);
  }

  /**
   * Test whether an account owns a coin in the cache.
   * @param {number} acct accound id
   * @param {Buffer} hash tx hash
   * @param {number} index tx index
   * @returns {Promise<boolean>} - Returns Boolean.
   */
  async hasCoinByAccount(acct, hash, index) {
    assert(typeof acct === 'number');
    return getOrCreate(
      ensureMap(this.cachedCoinsByAddress, acct),
      hash.toString('hex'),
      () => new Set()
    ).has(index);
  }
}

module.exports = CachedTXDB;

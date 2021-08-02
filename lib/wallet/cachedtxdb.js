// @ts-check

/*!
 * cachedtxdb.js - persistent transaction pool with in-memory cache
 * Copyright (c) 2021, Namebase Inc (MIT Licence).
 * https://github.com/namebasehq/hsd
 */

'use strict';

const assert = require('bsert');

const TXDB = require('./txdb');
const layout = require('./layout').txdb;
const Outpoint = require('../primitives/outpoint');

/** @typedef {import('./walletdb')} WalletDB */
/** @typedef {import('../primitives/coin')} Coin */
/** @typedef {import('./txdb').Credit} Credit */
/** @typedef {import('./wallet')} Wallet')} */
/** @typedef {import('./path')} Path} */

/**
 * @template K, V 
 * @param {Map<K, V>} parent 
 * @param {K} key 
 * @param {() => V} makeNew
 * @returns {V}
 */
 function getOrCreate(parent, key, makeNew) {
  if(parent.has(key)) {
    return parent.get(key);
  }

  const newVal = makeNew();
  parent.set(key, newVal);

  return newVal;
}

/**
 * @template K1, K2, V
 * @param {Map<K1, Map<K2, V>>} parent 
 * @param {K1} key 
 * @returns {Map<K2,V>}
 */
function ensureMap(parent, key) {
  return getOrCreate(parent, key, () => new Map());
}

/**
 * Duplicate a credit via encode/decode
 * 
 * @param {Credit} c 
 * @returns {Credit}
 */
function dupCredit(c) {
  c.encode();
  /** @type {Credit} */
  const dup = (/** @type {any} */ (TXDB.Credit.decode(c)));
  dup.coin.hash = Buffer.from(c.coin.hash);
  dup.coin.index = c.coin.index;
  return dup;
}

class CachedTXDB extends TXDB {
  /**
   * Create a TXDB with in-memory cache for coin selection
   * @param {WalletDB} wdb 
   * @param {string | number} wid 
   */
  constructor(wdb, wid) {
    super(wdb, wid);

    /** @type {Map<string, Map<number, Credit>>} */
    this.cachedCredits = new Map();
    /** @type {Map<number, Map<string, Set<number>>>} */
    this.cachedCoinsByAddress = new Map();
  }

  async _loadCredits() {
    /** @type {Credit[]} */
    const allCredits = await super.getCredits(-1);

    for(const c of allCredits) {
      this._insertCredit(c, await this.getPath(c.coin))
    }
  }

  /**
   * Inserta Credit into the cache
   * @param {Credit} credit
   * @param {Path} path
   */
  _insertCredit(credit, path) {
    const {coin} = credit;
    const hashHex = coin.hash.toString('hex');
    ensureMap(this.cachedCredits, hashHex).set(coin.index, credit);
    getOrCreate(
      ensureMap(this.cachedCoinsByAddress, path.account),
      hashHex,
      () => new Set()).add(coin.index);
  }

  /**
   * 
   * @param {Wallet} wallet 
   * @returns {Promise<any>}
   */
  async open(wallet) {
    const result = await super.open(wallet);
    await this._loadCredits();
    return result;
  }

  /**
   * Save credit.
   * @param {any} b bdb batch
   * @param {Credit} credit
   * @param {Path} path
   * @returns {Promise<any>}
   */
  async saveCredit(b, credit, path) {
    this._insertCredit(credit, path);
    return await super.saveCredit(b, credit, path);
  }
  
  /**
   * Remove credit.
   * @param {any} b bdb batch
   * @param {Credit} credit
   * @Aparam {Path} path
   * @returns {Promise<any>}
   */
  async removeCredit(b, credit, path) {
    const {coin} = credit;
    const hashHex = coin.hash.toString('hex');
    ensureMap(this.cachedCredits, hashHex).delete(coin.index);
    getOrCreate(
      ensureMap(this.cachedCoinsByAddress, path.account),
      hashHex,
      () => new Set()).delete(coin.index);

    return await super.removeCredit(b, credit, path);
  }

  /**
   * Get coins.
   * @param {number} acct
   * @returns {Promise<Credit[]>} - Returns {@link Credit}[].
   */
  async getCredits(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1) {
      return await this.getAccountCredits(acct)
    }
    
    return [...this.cachedCredits].flatMap(
      ([_, inner]) => [...inner].map(
        (([_, credit]) => dupCredit(credit))
      )
    );
  }

  /**
   * Get coin.
   * @param {Buffer} hash
   * @param {number} index
   * @returns {Promise<Credit | null>} - Returns {@link Credit}.
   */
  async getCredit(hash, index) {
    const hashHex = hash.toString('hex');
    const credit = ensureMap(this.cachedCredits, hashHex).get(index) ;
    
    if(!credit)
      return null;

    return dupCredit(credit);
  }

  /**
   * Get all outpoints from memory.
   * @param {number} acct
   * @returns {Promise<Outpoint[]>} - Returns {@link Outpoint}[].
   */

  async getOutpoints(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountOutpoints(acct);

    return [...this.cachedCredits].flatMap(
      ([hash, inner]) => [...inner].map(
        (([index, _]) => new Outpoint(hash, index))
      )
    );
  }

  /**
   * Get all coin hashes in the database.
   * @param {number} acct
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getAccountOutpoints(acct) {
    assert(typeof acct === 'number');
    return [...ensureMap(this.cachedCoinsByAddress, acct)].flatMap(
      ([hash, inner]) => [...inner].map(
        ((index) => new Outpoint(hash, index))
      )
    );
  }

  /**
   * Test whether the cache has a transaction.
   * @param {Buffer} hash
   * @returns {Promise<boolean>} - Returns Boolean.
   */
  async hasCoin(hash, index) {
    return ensureMap(this.cachedCredits, hash.toString('hex')).has(index);
  }

  /**
   * Test whether an account owns a coin in the cache.
   * @param {number} acct
   * @param {Buffer} hash
   * @param {number} index
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
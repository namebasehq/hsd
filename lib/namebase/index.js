'use strict';

const {
  handleBatchOpen,
  handleBatchReveal,
  handleBatchRevealWithCache,
  handleBatchBid,
  handleBatchFinish,
  handleSendMany,
  handleBidWithCache,
  handleOpenWithCache,
  handleClearCache,
  handleClearKeyFromCache
} = require('./http');

class NamebasePlugin {
  constructor(node) {
    this.node = node;
    this.logger = node.logger.context('NamebasePlugin');
  }

  async open() {
    const { node } = this;
    this.logger.info('initializing namebase plugin');

    if (!node.has('walletdb')) {
      this.logger.error('walletdb plugin is not present, terminating '
        + 'Namebase plugin execution');
      return;
    }

    const walletPlugin = node.get('walletdb');
    this.walletDB = walletPlugin.wdb;
    this.extendWallet(walletPlugin);
  }

  async close() {
    this.logger.info('terminating namebase plugin');
  }

  extendWallet(walletPlugin) {
    this.logger.info('registering http routes');
    const walletHttp = walletPlugin.http;
    // set context
    const context = {
      walletDB: this.walletDB
    };

    // Endpoints
    walletHttp.registerRoute('post', '/wallet/:id/openwithcache',
      handleOpenWithCache, context);
    walletHttp.registerRoute('post', '/wallet/:id/bidwithcache',
      handleBidWithCache, context);

    // Batch
    walletHttp.registerRoute('post', '/wallet/:id/batch/open',
      handleBatchOpen, context);
    walletHttp.registerRoute('post', '/wallet/:id/batch/reveal',
      handleBatchReveal, context);
    walletHttp.registerRoute('post', '/wallet/:id/batch/revealwithcache',
      handleBatchRevealWithCache, context);
    walletHttp.registerRoute('post', '/wallet/:id/batch/bid',
      handleBatchBid, context);
    walletHttp.registerRoute('post', '/wallet/:id/batch/finish',
      handleBatchFinish, context);

    walletHttp.registerRoute('post', '/wallet/:id/sendmany',
      handleSendMany, context);

    // Cache
    walletHttp.registerRoute('del', '/cache/:cacheName',
      handleClearCache, context);

    walletHttp.registerRoute('del', '/cache/:cacheName/:cacheKey',
      handleClearKeyFromCache, context);
  }
}

const plugin = exports;
plugin.id = 'Namebase';
plugin.init = node => new NamebasePlugin(node);

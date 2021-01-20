'use strict';

const bns = require('bns');
const {types} = require('bns/lib/constants');
const stream = require('stream');

const NameState = require('../covenants/namestate');
const {Resource} = require('../dns/resource');

/**
 * @typedef {import('../blockchain').Chain} Chain
 */

/**
 * readableStream produces a newline-delimited list of all
 * DNS records on a chain, except for RRSIG, as a utf8
 * encoded string.
 *
 * @param {Chain} chain the chain to stream from
 * @returns {stream.Readable} a readable stream of DNS records
 */
function readableStream(chain) {
  const iter = chain.db.tree.iterator(true);

  async function* gen() {
    while (await iter.next()) {
      /** @type {NameState} */
      const ns = NameState.decode(iter.value);
      if (ns.data.length <= 0)
        continue;

      /** @type {string} */
      const fqdn = bns.util.fqdn(ns.name.toString('ascii'));

      /** @type {Resource} */
      const resource = Resource.decode(ns.data);
      const zone = resource.toZone(fqdn);
      for (const record of zone) {
        if (record.type !== types.RRSIG && record.type !== types.TXT)
          yield record.toString() + '\n';
      }
    }
  }

  return stream.Readable.from(gen(), {encoding: 'utf8'});
}

module.exports = {
    readableStream: readableStream
};

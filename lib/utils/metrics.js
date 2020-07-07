'use strict';

const assert = require('assert');
const uuid = require('uuid');

/** @typedef { import('bmutex').Lock } Lock */

const metrics = exports;

/**
 * @typedef {Object} Honey
 */

class Event {
  /**
   *
   * @param {string} name the name for the event
   * @param {Event | Honey} parent a parent Event or a libhoney instance
   */
  constructor(name, parent) {
    assert(name, 'Event name is required');
    assert(parent, 'Parent event or libhoney instance is required.');
    if (parent instanceof Event) {
      this.honey = parent.honey;
      this.parent = parent;
      this.trace_id = parent.trace_id;
    } else {
      this.honey = parent;
      this.parent = null;
      this.trace_id = uuid.v4();
    }

    this.event = this.honey.newEvent();

    this.span_id = uuid.v4();
    this.startTime = process.hrtime();
    this.timers = new Map();

    this.addField('name', name);
    this.addField('service_name', 'hsd');
    this.addField('trace.span_id', this.span_id);
    this.addField('trace.trace_id', this.trace_id);
    if(this.parent) {
      this.addField('trace.parent_id', this.parent.span_id);
      this.addField('parent_id', this.parent.span_id);
    }
    this.event.timestamp = Date.now();
  }

  startTimer(name) {
    if(name) {
      this.timers.set(name, process.hrtime());
    } else {
      this.startTime = process.hrtime();
    }
  }

  /**
   * Measure how long it takes to get a lock
   * @param {Lock} lock a bmutex Lock
   * @returns {Promise<any>} a function to call to release the lock
   */
  async measureLockWait(lock) {
    this.addField('preLockQueueLength', lock.jobs.length);
    const preLockTime = process.hrtime();
    const unlock = lock.lock();

    this.addField('postLockQueueLength', lock.jobs.length);
    this.addField(
      'lockWaitTime',
      metrics.timerToMs(process.hrtime(preLockTime))
    );

    return unlock;
  }

  stopTimer(name) {
    const start = this.timers.get(name);
    if (start) {
      this.timers.delete(name);
      this.event.addField(
        `timer:${name}`,
        metrics.timerToMs(process.hrtime(start))
      );
    }
  }

  time(timerName, cb) {
    this.startTimer(timerName);
    const result = cb();
    this.stopTimer(timerName);
    return result;
  }

  async asyncSubEvent(name, cb) {
    const subEvent = metrics.newEvent(name, this);
    try {
      await cb(subEvent);
    } catch (err) {
      subEvent.addField('error', err.message);
      throw err;
    } finally {
      subEvent.send();
    }
  }

  send() {
    this.event.addField(
      'duration_ms',
      metrics.timerToMs(process.hrtime(this.startTime))
    );
    this.event.send();
  }

  /**
   * Add a field to the event
   * @param {string} key - the name of the field
   * @param {any} value - the value of the field
   * @returns {void}
   */
  addField(key, value) {
    this.event.addField(key, value);
  }
}

metrics.Event = Event;

/**
 * Generate a new, possibly subordinate, honeycomb trace event
 * @param {string} name the name for the event
 * @param {Event | Honey} parentOrHoney a parent Event or a libhoney instance
 * @returns {Event} the new event
 */
metrics.newEvent = (name, parentOrHoney) => {
  return new Event(name, parentOrHoney);
};

/**
 * Convert a high resolution timer to milliseconds
 * @param {NodeJS.HRTime} timer the high resolution timer to convert
 * @returns {number} a millisecond value
 */
metrics.timerToMs = (timer) => {
  return timer[0] * 1000 + timer[1] / 1000000;
};


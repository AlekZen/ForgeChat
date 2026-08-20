'use strict';

const pool = require('../db');
const { claimFollowUpInbound } = require('./followUpService');

async function dispatchIa360FollowUpInbound(record, {
  db = pool,
  claim = claimFollowUpInbound,
  sendDeferred,
  logger = console,
} = {}) {
  try {
    const result = await claim({ db, record });
    if (!result?.consumed) return { consumed: false };
    if (result.action === 'defer' && typeof sendDeferred === 'function') {
      await sendDeferred(record, result);
    }
    return result;
  } catch (error) {
    logger.error('[ia360-follow-up] dispatch error:', error.code || error.message);
    return { consumed: false };
  }
}

module.exports = { dispatchIa360FollowUpInbound };

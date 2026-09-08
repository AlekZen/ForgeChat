'use strict';

const pool = require('../db');
const { reconcileFollowUps } = require('./followUpService');

const INTERVAL_MS = 30_000;
let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await reconcileFollowUps({ db: pool, limit: 100 });
    if (result.locked && (result.requeued > 0 || result.scanned > 0)) {
      console.log('[follow-up-reconciler] scanned=%d requeued=%d', result.scanned, result.requeued);
    }
  } catch (error) {
    console.error('[follow-up-reconciler] error:', error.code || error.message);
  } finally {
    running = false;
  }
}

function startFollowUpReconciler() {
  if (timer) return timer;
  void tick();
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref();
  return timer;
}

function stopFollowUpReconciler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { startFollowUpReconciler, stopFollowUpReconciler, tick };

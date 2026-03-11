/**
 * moderate-service/rabbitmq.js
 *
 * RabbitMQ Manager for the Moderate Service
 * ──────────────────────────────────────────
 * Manages three queues:
 *
 *   1. "submit"          (consumer)  – reads jokes submitted by submit-service
 *   2. "moderated"       (producer)  – publishes moderator-approved jokes for ETL
 *   3. "mod_type_update" (consumer)  – receives ECST type_update events from ETL
 *
 * Event-Carried State Transfer (ECST):
 *   The ETL service writes to a "type_update" fanout exchange whenever a new
 *   joke type is created in the database. This service has a dedicated queue
 *   "mod_type_update" bound to that exchange. When a type_update event arrives,
 *   the local types.json cache is updated — no synchronous HTTP calls needed.
 *
 * Pending Message Handling:
 *   RabbitMQ uses manual acknowledgment. When a moderator reads a joke via
 *   GET /moderate, the raw AMQP message is held in pendingMsg (unacknowledged).
 *   - On approve: we ack pendingMsg + publish to "moderated"
 *   - On reject:  we nack pendingMsg with requeue=false (permanently discard)
 *   If the service restarts, RabbitMQ re-delivers the unacknowledged message.
 */

'use strict';

const amqp = require('amqplib');
const fs   = require('fs').promises;
const path = require('path');

const SUBMIT_QUEUE      = 'submit';
const MODERATED_QUEUE   = 'moderated';
const TYPE_EXCHANGE     = 'type_update';
const TYPE_QUEUE        = 'mod_type_update';
const CACHE_FILE        = path.join('/app/cache', 'types.json');

let connection    = null;
let consumerCh    = null;   // channel for consuming from submit queue
let producerCh    = null;   // channel for publishing to moderated queue
let typeCh        = null;   // channel for type_update ECST events
let isConnecting  = false;

// ── In-memory pending message ────────────────────────────────────────────────
// Holds the raw AMQP message currently being reviewed by the moderator.
// Only one message is held at a time (prefetch=1 enforces this).
let pendingMsg  = null;
let pendingJoke = null;

function getRabbitMQUrl() {
  const host = process.env.RABBITMQ_HOST     || 'rabbitmq';
  const user = process.env.RABBITMQ_USER     || 'guest';
  const pass = process.env.RABBITMQ_PASSWORD || 'guest';
  return `amqp://${user}:${pass}@${host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// connect() — establishes channels and starts the type_update consumer
// Auto-reconnects on error/close
// ─────────────────────────────────────────────────────────────────────────────
async function connect() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log('[RabbitMQ Moderate] Connecting…');
    connection = await amqp.connect(getRabbitMQUrl());
    console.log('[RabbitMQ Moderate] Connected');

    // ── Consumer channel: reads from submit queue ──────────────────────────
    consumerCh = await connection.createChannel();
    await consumerCh.assertQueue(SUBMIT_QUEUE, { durable: true });
    // prefetch(1): only hold one unacknowledged message at a time.
    // This ensures the moderator processes jokes one at a time.
    consumerCh.prefetch(1);

    // ── Producer channel: publishes to moderated queue ─────────────────────
    producerCh = await connection.createChannel();
    await producerCh.assertQueue(MODERATED_QUEUE, { durable: true });

    // ── Type update ECST channel ───────────────────────────────────────────
    typeCh = await connection.createChannel();
    // Fanout exchange: ETL broadcasts to all bound queues
    await typeCh.assertExchange(TYPE_EXCHANGE, 'fanout', { durable: true });
    // Declare and bind this service's dedicated queue
    await typeCh.assertQueue(TYPE_QUEUE, { durable: true });
    await typeCh.bindQueue(TYPE_QUEUE, TYPE_EXCHANGE, '');

    // Consume type_update events and update the local types cache
    typeCh.consume(TYPE_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        const event = JSON.parse(msg.content.toString());
        if (event.types && Array.isArray(event.types)) {
          await fs.mkdir('/app/cache', { recursive: true });
          await fs.writeFile(CACHE_FILE, JSON.stringify(event.types));
          console.log(
            `[RabbitMQ Moderate] Types cache updated via ECST (${event.types.length} types)`
          );
        }
        typeCh.ack(msg);
      } catch (err) {
        console.error('[RabbitMQ Moderate] Failed to process type_update:', err.message);
        typeCh.nack(msg, false, false);
      }
    });

    console.log('[RabbitMQ Moderate] Channels ready');
    isConnecting = false;

    // ── Reconnect handlers ─────────────────────────────────────────────────
    connection.on('error', (err) => {
      console.error('[RabbitMQ Moderate] Connection error:', err.message);
      _resetAndReconnect();
    });
    connection.on('close', () => {
      console.warn('[RabbitMQ Moderate] Connection closed — reconnecting in 5 s…');
      _resetAndReconnect();
    });

  } catch (err) {
    console.error('[RabbitMQ Moderate] Connect failed:', err.message, '— retrying in 5 s');
    _resetAndReconnect();
  }
}

function _resetAndReconnect() {
  connection    = null;
  consumerCh    = null;
  producerCh    = null;
  typeCh        = null;
  pendingMsg    = null;
  pendingJoke   = null;
  isConnecting  = false;
  setTimeout(connect, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// getNextJoke()
// Fetches one message from the "submit" queue using channel.get().
// If a message is already pending review (pendingMsg != null), returns it.
// If no message in queue, returns null.
//
// The message remains UNACKNOWLEDGED until approveJoke() or rejectJoke().
// ─────────────────────────────────────────────────────────────────────────────
async function getNextJoke() {
  // If a joke is already pending moderation, return it (allows page refresh)
  if (pendingJoke) return pendingJoke;

  if (!consumerCh) return null;

  const msg = await consumerCh.get(SUBMIT_QUEUE, { noAck: false });
  if (!msg) return null;

  const joke = JSON.parse(msg.content.toString());
  pendingMsg  = msg;
  pendingJoke = joke;

  console.log('[RabbitMQ Moderate] Fetched joke for moderation:', joke.setup);
  return joke;
}

// ─────────────────────────────────────────────────────────────────────────────
// approveJoke(editedJoke)
// ACKs the pending message and publishes the (possibly edited) joke to the
// "moderated" queue where ETL will consume and write it to the database.
// ─────────────────────────────────────────────────────────────────────────────
async function approveJoke(editedJoke) {
  if (!pendingMsg || !producerCh) {
    throw new Error('No pending joke to approve, or producer channel unavailable');
  }

  // Publish approved joke to moderated queue (persistent message)
  producerCh.sendToQueue(
    MODERATED_QUEUE,
    Buffer.from(JSON.stringify(editedJoke)),
    { persistent: true }
  );
  console.log('[RabbitMQ Moderate] Published to moderated queue:', editedJoke.setup);

  // ACK the original submit message — removes it from the submit queue
  consumerCh.ack(pendingMsg);
  console.log('[RabbitMQ Moderate] Acknowledged submit message (approved)');

  pendingMsg  = null;
  pendingJoke = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectJoke()
// NACKs the pending message with requeue=false — permanently discards it.
// The joke will NOT be re-queued and will NOT reach the database.
// ─────────────────────────────────────────────────────────────────────────────
async function rejectJoke() {
  if (!pendingMsg) {
    throw new Error('No pending joke to reject');
  }

  consumerCh.nack(pendingMsg, false, false);
  console.log('[RabbitMQ Moderate] Nacked submit message (rejected/discarded)');

  pendingMsg  = null;
  pendingJoke = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// isReady() — true when all channels are established
// ─────────────────────────────────────────────────────────────────────────────
function isReady() {
  return connection !== null && consumerCh !== null && producerCh !== null;
}

module.exports = { connect, getNextJoke, approveJoke, rejectJoke, isReady };

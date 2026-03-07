/**
 * moderator-service/rabbitmq.js
 *
 * RabbitMQ Connection Manager — Moderator Service
 * ─────────────────────────────────────────────────
 *
 * ── Queues ──────────────────────────────────────────────────
 *   submit          – pull user-submitted jokes for review
 *                     (noAck=false → manual ack/nack)
 *   moderated       – publish approved jokes → ETL → MySQL
 *   mod_type_update – receive type_update events from the
 *                     "type_updates" fanout exchange
 *
 * ── Exchange ────────────────────────────────────────────────
 *   type_updates (fanout, durable)
 *     Published by:  ETL when a brand-new type is created
 *     Bound queues:  mod_type_update  (this service)
 *                    sub_type_update  (submit-service)
 *
 * ── Manual ACK pattern ──────────────────────────────────────
 *   channel.get('submit', { noAck: false }) pulls exactly one
 *   message without consuming it. The message stays "in-flight"
 *   (unacknowledged) until the moderator either:
 *     • Approves  → channel.ack(msg)   removes it permanently
 *     • Rejects   → channel.nack(msg, false, false)  discards it
 *
 *   If this service crashes while a message is in-flight,
 *   RabbitMQ automatically redelivers it (at-least-once delivery).
 *
 * ── Event-Carried State Transfer ────────────────────────────
 *   The mod_type_update consumer calls typeUpdateCallback when a
 *   new type event arrives, allowing server.js to update the
 *   local types cache without polling any external service.
 */

'use strict';

const amqp = require('amqplib');

// ── Queue / exchange names ────────────────────────────────────
const SUBMIT_QUEUE      = 'submit';
const MODERATED_QUEUE   = 'moderated';
const TYPE_UPDATE_QUEUE = 'mod_type_update';
const TYPE_UPDATE_EXCH  = 'type_updates';

// ── Shared state ─────────────────────────────────────────────
let channel      = null;
let connection   = null;
let isConnecting = false;

let typeUpdateCallback = null; // called with each type_update event
let reconnectCallback  = null; // called when connection drops

// ─────────────────────────────────────────────────────────────
function getRabbitMQUrl() {
  const host = process.env.RABBITMQ_HOST     || 'rabbitmq';
  const user = process.env.RABBITMQ_USER     || 'guest';
  const pass = process.env.RABBITMQ_PASSWORD || 'guest';
  return `amqp://${user}:${pass}@${host}`;
}

// ─────────────────────────────────────────────────────────────
// connect()
//
// Establishes the connection, asserts all queues/exchange, and
// starts the type_update consumer. Reconnects automatically on
// any error or unexpected close.
// ─────────────────────────────────────────────────────────────
async function connect() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log('[Moderator RabbitMQ] Connecting…');
    connection = await amqp.connect(getRabbitMQUrl());
    channel    = await connection.createChannel();

    // ── Queues ──────────────────────────────────────────────
    // durable: true — queue definitions survive broker restart.
    await channel.assertQueue(SUBMIT_QUEUE,    { durable: true });
    await channel.assertQueue(MODERATED_QUEUE, { durable: true });

    // ── Fanout exchange + type-update queue ─────────────────
    // durable: true — exchange definition survives broker restart.
    await channel.assertExchange(TYPE_UPDATE_EXCH, 'fanout', { durable: true });
    await channel.assertQueue(TYPE_UPDATE_QUEUE, { durable: true });
    // Bind this queue to the fanout exchange (routing key '' is ignored by fanout)
    await channel.bindQueue(TYPE_UPDATE_QUEUE, TYPE_UPDATE_EXCH, '');

    // ── Consume type_update events ──────────────────────────
    // Auto-ack is handled manually inside the handler so we
    // can nack malformed events without crashing the consumer.
    channel.consume(TYPE_UPDATE_QUEUE, (msg) => {
      if (!msg) return; // consumer was cancelled
      try {
        const event = JSON.parse(msg.content.toString());
        console.log('[Moderator RabbitMQ] type_update received:', event);
        if (typeUpdateCallback) typeUpdateCallback(event);
        channel.ack(msg);
      } catch (err) {
        console.error('[Moderator RabbitMQ] Malformed type_update — discarding:', err.message);
        channel.nack(msg, false, false); // discard, don't requeue
      }
    });

    console.log('[Moderator RabbitMQ] ✅ Connected and ready.');
    isConnecting = false;

    // ── Handle unexpected disconnection ─────────────────────
    const handleDrop = (reason) => {
      console.warn(`[Moderator RabbitMQ] ${reason} — reconnecting in 5 s…`);
      channel      = null;
      connection   = null;
      isConnecting = false;
      // Notify server.js to clear any in-flight pending joke.
      // RabbitMQ will redeliver the unacked message automatically.
      if (reconnectCallback) reconnectCallback();
      setTimeout(connect, 5000);
    };

    connection.on('error', err => handleDrop(`Connection error: ${err.message}`));
    connection.on('close', ()  => handleDrop('Connection closed'));

  } catch (err) {
    console.error('[Moderator RabbitMQ] Connect failed:', err.message, '— retrying in 5 s');
    channel      = null;
    connection   = null;
    isConnecting = false;
    setTimeout(connect, 5000);
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Pull one message from the "submit" queue without auto-acking.
 * The message stays in-flight until ackJoke() or rejectJoke() is called.
 *
 * @returns {{ content: Object, rawMsg: Object } | null}
 */
async function getNextJoke() {
  if (!channel) return null;
  const msg = await channel.get(SUBMIT_QUEUE, { noAck: false });
  if (!msg) return null;
  const content = JSON.parse(msg.content.toString());
  return { content, rawMsg: msg };
}

/**
 * Acknowledge an in-flight message (moderator approved).
 * Permanently removes the message from the queue.
 *
 * @param {Object} rawMsg – the original amqplib message object
 */
function ackJoke(rawMsg) {
  if (!channel) throw new Error('RabbitMQ channel not available');
  channel.ack(rawMsg);
}

/**
 * Negative-acknowledge an in-flight message (moderator rejected).
 * requeue=false → discards the message (no dead-letter in this setup).
 *
 * @param {Object} rawMsg – the original amqplib message object
 */
function rejectJoke(rawMsg) {
  if (!channel) throw new Error('RabbitMQ channel not available');
  channel.nack(rawMsg, false, false);
}

/**
 * Publish an approved, moderated joke to the "moderated" queue.
 * persistent: true — message survives a broker restart before ETL consumes it.
 *
 * @param {{ setup: string, punchline: string, type: string }} joke
 */
function publishModerated(joke) {
  if (!channel) throw new Error('RabbitMQ channel not available');
  const payload = Buffer.from(JSON.stringify({
    ...joke,
    moderatedAt: new Date().toISOString()
  }));
  channel.sendToQueue(MODERATED_QUEUE, payload, { persistent: true });
  console.log('[Moderator RabbitMQ] Published to "moderated":', joke);
}

/**
 * Register a callback for type_update events (Event-Carried State Transfer).
 * Called with the parsed event object whenever ETL creates a new type.
 *
 * @param {Function} callback – fn(event: { event, type: { id, name }, timestamp })
 */
function onTypeUpdate(callback) {
  typeUpdateCallback = callback;
}

/**
 * Register a callback invoked when the RabbitMQ connection drops.
 * Used by server.js to clear any in-flight pending joke state.
 *
 * @param {Function} callback – fn()
 */
function onReconnect(callback) {
  reconnectCallback = callback;
}

/** Returns true when a channel is available for publish/get operations. */
function isReady() {
  return !!channel;
}

module.exports = {
  connect,
  getNextJoke,
  ackJoke,
  rejectJoke,
  publishModerated,
  onTypeUpdate,
  onReconnect,
  isReady
};

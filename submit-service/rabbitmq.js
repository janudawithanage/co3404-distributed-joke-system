/**
 * submit-service/rabbitmq.js
 *
 * RabbitMQ Connection Manager
 * ───────────────────────────
 * Distributed Systems Notes:
 *
 *   durable queue  – the queue definition survives a RabbitMQ restart.
 *   persistent msg – each message is written to disk by the broker,
 *                    so it survives a broker restart before being consumed.
 *   Auto-reconnect – if the broker goes down temporarily, the manager
 *                    schedules a reconnect rather than crashing the service.
 *                    This is important: Submit should remain available even
 *                    if RabbitMQ restarts (resilience requirement).
 *
 * The channel is a singleton shared by all HTTP request handlers.
 */

'use strict';

const amqp = require('amqplib');

// Option 3: published to 'jokes_queue' (direct to ETL).
// Option 4: publishes to 'submit'; Moderator consumes and forwards to 'moderated'.
const QUEUE_NAME        = 'submit';
const TYPE_UPDATE_QUEUE = 'sub_type_update';
const TYPE_UPDATE_EXCH  = 'type_updates'; // fanout exchange (ETL publishes here)

let typeUpdateCallback = null; // called with each type_update event

let channel      = null;
let connection   = null;
let isConnecting = false; // guard against parallel reconnect loops

function getRabbitMQUrl() {
  const host = process.env.RABBITMQ_HOST     || 'rabbitmq';
  const user = process.env.RABBITMQ_USER     || 'guest';
  const pass = process.env.RABBITMQ_PASSWORD || 'guest';
  return `amqp://${user}:${pass}@${host}`;
}

async function connect() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log('[RabbitMQ] Connecting…');
    connection = await amqp.connect(getRabbitMQUrl());
    channel    = await connection.createChannel();

    // durable: true – queue survives a broker restart
    await channel.assertQueue(QUEUE_NAME, { durable: true });

    // ── Event-Carried State Transfer setup ─────────────────────
    // Assert the fanout exchange (idempotent — safe to call repeatedly).
    // Bind a durable queue so type_update events survive broker restarts.
    await channel.assertExchange(TYPE_UPDATE_EXCH, 'fanout', { durable: true });
    await channel.assertQueue(TYPE_UPDATE_QUEUE, { durable: true });
    await channel.bindQueue(TYPE_UPDATE_QUEUE, TYPE_UPDATE_EXCH, '');

    // Consume type_update events → update the local types cache
    channel.consume(TYPE_UPDATE_QUEUE, (msg) => {
      if (!msg) return;
      try {
        const event = JSON.parse(msg.content.toString());
        console.log('[Submit RabbitMQ] type_update event received:', event);
        if (typeUpdateCallback) typeUpdateCallback(event);
        channel.ack(msg);
      } catch (err) {
        console.error('[Submit RabbitMQ] Malformed type_update — discarding:', err.message);
        channel.nack(msg, false, false);
      }
    });

    console.log(`[Submit RabbitMQ] Connected. Queue "${QUEUE_NAME}" asserted.`);
    isConnecting = false;

    // ── Handle unexpected disconnection ──────────────────
    connection.on('error', err => {
      console.error('[RabbitMQ] Connection error:', err.message);
      channel      = null;
      connection   = null;
      isConnecting = false;
      setTimeout(connect, 5000); // retry in 5 s
    });

    connection.on('close', () => {
      console.warn('[RabbitMQ] Connection closed – reconnecting in 5 s…');
      channel      = null;
      connection   = null;
      isConnecting = false;
      setTimeout(connect, 5000);
    });

  } catch (err) {
    console.error('[RabbitMQ] Connect failed:', err.message, '– retrying in 5 s');
    channel      = null;
    connection   = null;
    isConnecting = false;
    setTimeout(connect, 5000);
  }
}

/**
 * Publish a joke object to the jokes_queue.
 *
 * persistent: true ensures the message is written to disk
 * by RabbitMQ, surviving a broker restart before the ETL
 * consumer has had a chance to process it.
 *
 * @param {Object} jokeData – { setup, punchline, type }
 * @throws if the channel is not available
 */
async function publishJoke(jokeData) {
  if (!channel) {
    throw new Error('RabbitMQ channel not available – broker may be down');
  }
  const payload = Buffer.from(JSON.stringify(jokeData));
  channel.sendToQueue(QUEUE_NAME, payload, { persistent: true });
  console.log(`[RabbitMQ] Published to "${QUEUE_NAME}":`, jokeData);
}

/** Register callback for type_update events (Event-Carried State Transfer) */
function onTypeUpdate(callback) {
  typeUpdateCallback = callback;
}

module.exports = { connect, publishJoke, onTypeUpdate };

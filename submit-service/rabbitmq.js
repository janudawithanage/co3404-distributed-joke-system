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

const QUEUE_NAME = 'submitted_jokes';

let channel     = null;
let connection  = null;
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
    console.log(`[RabbitMQ] Connected. Queue "${QUEUE_NAME}" asserted.`);
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

module.exports = { connect, publishJoke };

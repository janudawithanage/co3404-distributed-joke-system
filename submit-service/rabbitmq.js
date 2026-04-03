/**
 * submit-service/rabbitmq.js
 *
 * RabbitMQ Connection Manager — Option 4
 * ───────────────────────────────────────
 * Manages two concerns:
 *
 *   1. PRODUCER: publishes submitted jokes to the "submit" queue.
 *      The moderate-service consumes this queue for human review.
 *
 *   2. ECST CONSUMER: subscribes to the "sub_type_update" queue which
 *      is bound to the "type_update" fanout exchange published by ETL.
 *      When a new joke type is written to the database, ETL broadcasts
 *      the full updated types list. This service writes it to the local
 *      types.json cache file — no synchronous HTTP call to joke-service.
 *
 * Distributed Systems Notes:
 *   durable queue  – queue definition survives a RabbitMQ restart.
 *   persistent msg – each message is written to disk by the broker,
 *                    so it survives a broker restart before being consumed.
 *   Auto-reconnect – if the broker goes down temporarily, the manager
 *                    schedules a reconnect rather than crashing the service.
 */

'use strict';

const amqp = require('amqplib');
const fs   = require('fs').promises;
const path = require('path');

const SUBMIT_QUEUE   = 'submit';          // submit → moderate (renamed from submitted_jokes)
const TYPE_EXCHANGE  = 'type_update';     // ECST fanout exchange (published by ETL)
const TYPE_QUEUE     = 'sub_type_update'; // this service's dedicated subscriber queue
const CACHE_FILE     = path.join('/app/cache', 'types.json');

let channel      = null;
let connection   = null;
let isConnecting = false;

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
    console.log('[RabbitMQ Submit] Connecting…');
    connection = await amqp.connect(getRabbitMQUrl());

    // ── Producer channel ─────────────────────────────────────────────────────
    channel = await connection.createChannel();
    await channel.assertQueue(SUBMIT_QUEUE, { durable: true });
    console.log(`[RabbitMQ Submit] Producer ready. Queue "${SUBMIT_QUEUE}" asserted.`);

    // ── ECST consumer channel ─────────────────────────────────────────────────
    const typeCh = await connection.createChannel();
    // Declare the exchange (idempotent — safe if ETL already declared it)
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
            `[RabbitMQ Submit] ECST types cache updated (${event.types.length} types)`
          );
        }
        typeCh.ack(msg);
      } catch (err) {
        console.error('[RabbitMQ Submit] Failed to process type_update:', err.message);
        typeCh.nack(msg, false, false);
      }
    });

    console.log(`[RabbitMQ Submit] ECST subscriber ready. Queue "${TYPE_QUEUE}" bound.`);
    isConnecting = false;

    // ── Handle unexpected disconnection ──────────────────────────────────────
    connection.on('error', err => {
      console.error('[RabbitMQ Submit] Connection error:', err.message);
      channel = null; connection = null; isConnecting = false;
      setTimeout(connect, 5000);
    });
    connection.on('close', () => {
      console.warn('[RabbitMQ Submit] Connection closed – reconnecting in 5 s…');
      channel = null; connection = null; isConnecting = false;
      setTimeout(connect, 5000);
    });

  } catch (err) {
    console.error('[RabbitMQ Submit] Connect failed:', err.message, '– retrying in 5 s');
    channel = null; connection = null; isConnecting = false;
    setTimeout(connect, 5000);
  }
}

/**
 * Publish a joke to the "submit" queue for moderation.
 * persistent: true ensures the message survives a broker restart.
 */
async function publishJoke(jokeData) {
  if (!channel) {
    throw new Error('RabbitMQ channel not available – broker may be down');
  }
  const payload = Buffer.from(JSON.stringify(jokeData));
  channel.sendToQueue(SUBMIT_QUEUE, payload, { persistent: true });
  console.log(`[RabbitMQ Submit] Published to "${SUBMIT_QUEUE}":`, jokeData);
}

module.exports = { connect, publishJoke };

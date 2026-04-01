/**
 * etl-service/server.js
 *
 * ETL (Extract → Transform → Load) Microservice  — Option 4
 * ──────────────────────────────────────────────────────────
 * Responsibilities:
 *   - Consume messages from RabbitMQ "moderated" queue
 *     (jokes approved by the human moderator microservice)
 *   - Insert joke into MySQL or MongoDB (DB_TYPE env var)
 *   - After inserting a NEW joke type: publish a type_update
 *     ECST event to the "type_update" fanout exchange so that
 *     submit-service and moderate-service refresh their caches
 *   - Acknowledge the message ONLY after a successful DB write
 *   - On DB failure: nack the message so it is re-queued
 *   - Reconnect to both MySQL/MongoDB and RabbitMQ if they go down
 *   - GET /health – health endpoint
 *
 * ── Message Flow (Option 4) ───────────────────────────────
 *   submit-service
 *       → RabbitMQ "submit" queue
 *           → moderate-service (human review)
 *               → RabbitMQ "moderated" queue
 *                   → ETL (THIS) → MySQL or MongoDB
 *
 * ── ECST type_update Flow ─────────────────────────────────
 *   ETL detects new type created in DB
 *       → publishes to "type_update" fanout exchange
 *           → "sub_type_update" queue → submit-service
 *           → "mod_type_update" queue → moderate-service
 *   Both services update their local types.json cache file.
 *
 * ── Distributed Systems Notes ─────────────────────────────
 *   At-least-once delivery via manual ACK/NACK.
 *   prefetch(1) prevents message flooding during DB slowdowns.
 *   Infinite reconnect loop ensures self-healing.
 */

'use strict';

const amqp    = require('amqplib');
const express = require('express');
const helmet  = require('helmet');
const { connectWithRetry, insertJoke, getAllTypes } = require('./db');

const app  = express();
const PORT = process.env.PORT || 4001;

// Security headers
app.use(helmet());

const MODERATED_QUEUE = 'moderated';
const TYPE_EXCHANGE   = 'type_update'; // fanout exchange for ECST events

function getRabbitMQUrl() {
  const host = process.env.RABBITMQ_HOST     || 'rabbitmq';
  const user = process.env.RABBITMQ_USER     || 'guest';
  const pass = process.env.RABBITMQ_PASSWORD || 'guest';
  return `amqp://${user}:${pass}@${host}`;
}

// ─────────────────────────────────────────────────────────────
// publishTypeUpdate(publishCh)
//
// Fetches all current types from the database and publishes them
// to the "type_update" fanout exchange.  All bound queues
// (sub_type_update, mod_type_update) receive the full updated list.
//
// Event-Carried State Transfer pattern:
//   The event carries the complete new state (all types) not just
//   the delta. This allows any subscriber that was offline to
//   fully recover by processing the latest event.
// ─────────────────────────────────────────────────────────────
async function publishTypeUpdate(publishCh) {
  try {
    const types   = await getAllTypes();
    const payload = Buffer.from(JSON.stringify({ types }));
    publishCh.publish(TYPE_EXCHANGE, '', payload, { persistent: true });
    console.log(`[ETL] 📡 ECST type_update published (${types.length} types)`);
  } catch (err) {
    console.error('[ETL] Failed to publish type_update ECST event:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RabbitMQ consumer (with infinite retry)
// ─────────────────────────────────────────────────────────────
async function startConsumer() {
  while (true) {
    let conn = null;
    try {
      conn = await amqp.connect(getRabbitMQUrl());
      console.log('[ETL] Connected to RabbitMQ');

      // ── Consumer channel ─────────────────────────────────────
      const channel = await conn.createChannel();
      await channel.assertQueue(MODERATED_QUEUE, { durable: true });
      channel.prefetch(1);

      // ── Publisher channel for ECST type_update events ─────────
      // Separate channel to avoid consumer/publisher interference
      const publishCh = await conn.createChannel();
      // Declare the fanout exchange (idempotent, safe to call repeatedly)
      // durable: true – exchange definition survives broker restart
      await publishCh.assertExchange(TYPE_EXCHANGE, 'fanout', { durable: true });

      // Pre-declare the subscriber queues and bind them to the exchange.
      // This ensures the queues exist even if the subscriber services
      // haven't started yet (no events are lost at startup).
      await publishCh.assertQueue('sub_type_update', { durable: true });
      await publishCh.bindQueue('sub_type_update', TYPE_EXCHANGE, '');
      await publishCh.assertQueue('mod_type_update', { durable: true });
      await publishCh.bindQueue('mod_type_update', TYPE_EXCHANGE, '');

      // ── Startup broadcast ────────────────────────────────────
      // Publish the full types list from DB immediately so that
      // submit-service and moderate-service caches are populated
      // even when the DB was seeded directly (not via the pipeline).
      console.log('[ETL] Broadcasting current types on startup…');
      await publishTypeUpdate(publishCh);

      console.log(`[ETL] Waiting for messages on "${MODERATED_QUEUE}"…`);

      await new Promise((resolve, reject) => {
        conn.on('error', err => {
          console.error('[ETL] RabbitMQ error:', err.message);
          reject(err);
        });
        conn.on('close', () => {
          console.warn('[ETL] RabbitMQ connection closed – will reconnect');
          reject(new Error('Connection closed'));
        });

        // ── Message handler ──────────────────────────────────────
        channel.consume(MODERATED_QUEUE, async (msg) => {
          if (!msg) return;

          const raw = msg.content.toString();
          console.log('[ETL] Received moderated joke:', raw);

          // Step 1: Parse
          let joke;
          try {
            joke = JSON.parse(raw);
          } catch (_) {
            console.error('[ETL] ❌ Invalid JSON — discarding:', raw);
            channel.nack(msg, false, false);
            return;
          }

          // Step 2: Validate
          if (!joke.setup || !joke.punchline || !joke.type) {
            console.error('[ETL] ❌ Missing fields — discarding:', joke);
            channel.nack(msg, false, false);
            return;
          }

          // Step 3: Write to DB
          try {
            const { isNewType } = await insertJoke(joke);

            // ACK only after successful DB write
            channel.ack(msg);

            // Step 4: If new type was created, emit ECST type_update event
            if (isNewType) {
              console.log(`[ETL] New type detected: "${joke.type}" — emitting ECST event`);
              await publishTypeUpdate(publishCh);
            }

          } catch (dbErr) {
            console.error('[ETL] ❌ DB write failed — requeuing:', dbErr.message);
            // Transient DB error → requeue for retry
            channel.nack(msg, false, true);
          }
        });
      });

    } catch (err) {
      console.error('[ETL] Connection error – retrying in 5 s:', err.message);
      if (conn) {
        try { await conn.close(); } catch (_) { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'etl-service',
    dbType:    process.env.DB_TYPE || 'mysql',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
let server;
async function start() {
  try {
    await connectWithRetry();

    server = app.listen(PORT, () => {
      console.log(`[ETL Service] Health endpoint at http://localhost:${PORT}/health`);
      console.log(`[ETL Service] DB type: ${process.env.DB_TYPE || 'mysql'}`);
    });

    startConsumer(); // infinite retry loop — does not resolve or reject under normal operation

  } catch (err) {
    console.error('[ETL Service] Fatal startup error:', err.message);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown — close HTTP server on SIGTERM/SIGINT
// Docker sends SIGTERM on `docker stop`. This ensures in-flight
// requests complete before the container exits.
// ─────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[ETL Service] ${signal} received — shutting down gracefully…`);
  if (server) {
    server.close(() => {
      console.log('[ETL Service] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start();

/**
 * etl-service/server.js
 *
 * ETL (Extract → Transform → Load) Microservice
 * ──────────────────────────────────────────────
 * Responsibilities:
 *   - Consume messages from RabbitMQ "jokes_queue"
 *   - Insert joke type if not already present (idempotent)
 *   - Insert the joke into MySQL
 *   - Acknowledge the message ONLY after a successful DB write
 *   - On DB failure: nack the message so it is re-queued
 *   - Reconnect to both MySQL and RabbitMQ if they go down
 *   - GET /health – optional health endpoint
 *
 * ── Distributed Systems Notes ─────────────────────────────
 *
 *  At-least-once delivery:
 *    RabbitMQ only removes a message from the queue after the
 *    consumer sends an ACK (channel.ack). If the ETL service
 *    crashes before the ACK is sent, RabbitMQ re-delivers the
 *    message on the next connection. This guarantees no data loss.
 *
 *  Idempotent type insert (INSERT IGNORE):
 *    The types table has a UNIQUE constraint on name.
 *    INSERT IGNORE silently skips duplicate inserts, so it is
 *    safe to process the same message twice (re-delivery).
 *
 *  prefetch(1):
 *    Tells RabbitMQ to send at most 1 unacknowledged message
 *    at a time. This prevents the ETL from being flooded if
 *    the DB is slow, and ensures fair dispatch when scaling.
 *
 *  Infinite reconnect loop:
 *    In a distributed system the broker or DB can restart at
 *    any time. The while(true)/try-catch loop ensures the ETL
 *    self-heals without manual intervention.
 *
 * ── Message Flow ──────────────────────────────────────────
 *   Submit Service → RabbitMQ (jokes_queue) → ETL → MySQL
 */

'use strict';

const amqp    = require('amqplib');
const express = require('express');
const { pool, connectWithRetry } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3003;

const QUEUE_NAME = 'jokes_queue';

function getRabbitMQUrl() {
  const host = process.env.RABBITMQ_HOST     || 'rabbitmq';
  const user = process.env.RABBITMQ_USER     || 'guest';
  const pass = process.env.RABBITMQ_PASSWORD || 'guest';
  return `amqp://${user}:${pass}@${host}`;
}

// ─────────────────────────────────────────────────────────────
// Database helpers
// ─────────────────────────────────────────────────────────────

/**
 * Get the ID of an existing type, or create it if it doesn't exist.
 *
 * INSERT IGNORE + SELECT pattern:
 *   1. Attempt to insert (silently skipped if name already exists)
 *   2. Always SELECT to retrieve the canonical ID
 *
 * This is safe under concurrent access thanks to the UNIQUE
 * constraint and MySQL's transactional INSERT IGNORE behaviour.
 */
async function getOrCreateType(typeName) {
  const name = typeName.trim().toLowerCase();
  await pool.query(
    'INSERT IGNORE INTO types (name) VALUES (?)',
    [name]
  );
  const [rows] = await pool.query(
    'SELECT id FROM types WHERE name = ?',
    [name]
  );
  if (!rows.length) {
    throw new Error(`Type not found after INSERT IGNORE: "${name}"`);
  }
  return rows[0].id;
}

/**
 * Insert a joke into the database.
 * Steps:
 *   1. Resolve (or create) the joke type
 *   2. Insert the joke row linked to that type
 *
 * @param {{ setup: string, punchline: string, type: string }} joke
 */
async function insertJoke({ setup, punchline, type }) {
  if (!setup || !punchline || !type) {
    throw new Error('Message missing required fields: setup, punchline, type');
  }
  const typeId = await getOrCreateType(type);
  await pool.query(
    'INSERT INTO jokes (setup, punchline, type_id) VALUES (?, ?, ?)',
    [setup, punchline, typeId]
  );
  console.log(
    `[ETL] ✅ Inserted joke (type: ${type}): "${String(setup).substring(0, 50)}…"`
  );
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

      const channel = await conn.createChannel();

      // durable: true – queue definition survives broker restart
      await channel.assertQueue(QUEUE_NAME, { durable: true });

      // prefetch(1) – process one message at a time
      channel.prefetch(1);

      console.log(`[ETL] Waiting for messages on "${QUEUE_NAME}"…`);

      // Wrap in a Promise so the while loop blocks here until
      // the connection closes, then retries from the top.
      await new Promise((resolve, reject) => {
        conn.on('error', err => {
          console.error('[ETL] RabbitMQ error:', err.message);
          reject(err);
        });
        conn.on('close', () => {
          console.warn('[ETL] RabbitMQ connection closed – will reconnect');
          reject(new Error('Connection closed'));
        });

        // ── Message handler ──────────────────────────────
        channel.consume(QUEUE_NAME, async (msg) => {
          if (!msg) return; // consumer cancelled

          const raw = msg.content.toString();
          console.log('[ETL] Received:', raw);

          try {
            const joke = JSON.parse(raw);
            await insertJoke(joke);

            // ACK only after successful DB write.
            // If we crash here before ACK, RabbitMQ re-delivers.
            channel.ack(msg);

          } catch (err) {
            console.error('[ETL] ❌ Failed to process message:', err.message);

            // nack(msg, allUpTo=false, requeue=true)
            // Requeues the message for another delivery attempt.
            // Note: in production you would add a dead-letter queue
            // to handle poison messages that always fail.
            channel.nack(msg, false, true);
          }
        });
      });

    } catch (err) {
      console.error('[ETL] Connection error – retrying in 5 s:', err.message);
      if (conn) {
        try { await conn.close(); } catch (_) { /* ignore close errors */ }
      }
      await new Promise(res => setTimeout(res, 5000));
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
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // Connect to MySQL with retry before accepting any messages
    await connectWithRetry();

    // Start the health-check HTTP server
    app.listen(PORT, () => {
      console.log(`[ETL Service] Health endpoint at http://localhost:${PORT}/health`);
    });

    // Start the consumer loop (runs indefinitely in background)
    // Not awaited – startConsumer() loops forever and handles
    // its own errors internally.
    startConsumer().catch(err => {
      // Should never reach here due to internal while(true),
      // but catch as a safety net
      console.error('[ETL] Unexpected consumer exit:', err.message);
      process.exit(1);
    });

  } catch (err) {
    console.error('[ETL Service] Fatal startup error:', err.message);
    process.exit(1);
  }
}

start();

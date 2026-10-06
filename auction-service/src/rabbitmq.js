const amqp = require('amqplib');

let connection = null;
let channel = null;

const EXCHANGE_NAME = 'auction_events';
const EXCHANGE_TYPE = 'topic';

async function connectRabbitMQ(retryCount = 10, delay = 3000) {
  const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

  for (let i = 0; i < retryCount; i++) {
    try {
      connection = await amqp.connect(rabbitmqUrl);
      channel = await connection.createChannel();

      await channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });
      console.log(`[auction-rabbitmq] Connected to RabbitMQ and asserted exchange "${EXCHANGE_NAME}"`);

      connection.on('error', (err) => {
        console.error('[auction-rabbitmq] Connection error:', err.message);
      });

      connection.on('close', () => {
        console.warn('[auction-rabbitmq] Connection closed. Attempting reconnect in 5s...');
        setTimeout(() => connectRabbitMQ(), 5000);
      });

      return { connection, channel };
    } catch (err) {
      console.warn(`[auction-rabbitmq] Connection attempt ${i + 1}/${retryCount} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  console.error('[auction-rabbitmq] Exhausted retries connecting to RabbitMQ.');
  return null;
}

async function publishBidPlaced(payload) {
  if (!channel) {
    console.warn('[auction-rabbitmq] Channel not ready. Attempting reconnect...');
    await connectRabbitMQ(3, 1000);
  }

  if (!channel) {
    throw new Error('RabbitMQ channel unavailable. Failed to publish event.');
  }

  const routingKey = 'bid.placed';
  const buffer = Buffer.from(JSON.stringify(payload));

  const published = channel.publish(EXCHANGE_NAME, routingKey, buffer, {
    persistent: true,
    contentType: 'application/json',
  });

  console.log(`[auction-rabbitmq] Published "${routingKey}" to "${EXCHANGE_NAME}":`, payload);
  return published;
}

module.exports = {
  connectRabbitMQ,
  publishBidPlaced,
  EXCHANGE_NAME,
};

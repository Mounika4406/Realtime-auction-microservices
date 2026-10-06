const amqp = require('amqplib');

const EXCHANGE_NAME = 'auction_events';
const EXCHANGE_TYPE = 'topic';
const QUEUE_NAME = 'q_notification_generator';
const ROUTING_KEY = 'bid.placed';

let connection = null;
let channel = null;

async function startRabbitMQConsumer(onMessageCallback, retryCount = 10, delay = 3000) {
  const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

  for (let i = 0; i < retryCount; i++) {
    try {
      connection = await amqp.connect(rabbitmqUrl);
      channel = await connection.createChannel();

      await channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });
      await channel.assertQueue(QUEUE_NAME, { durable: true });
      await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

      console.log(`[notification-rabbitmq] Queue "${QUEUE_NAME}" bound to exchange "${EXCHANGE_NAME}" with routing key "${ROUTING_KEY}"`);

      channel.consume(QUEUE_NAME, async (msg) => {
        if (!msg) return;
        try {
          const content = JSON.parse(msg.content.toString());
          console.log(`[notification-rabbitmq] Received message from queue "${QUEUE_NAME}":`, content);
          await onMessageCallback(content);
          channel.ack(msg);
        } catch (err) {
          console.error('[notification-rabbitmq] Error processing consumed message:', err.message);
          channel.nack(msg, false, false);
        }
      });

      connection.on('error', (err) => {
        console.error('[notification-rabbitmq] Connection error:', err.message);
      });

      connection.on('close', () => {
        console.warn('[notification-rabbitmq] Connection closed. Reconnecting in 5s...');
        setTimeout(() => startRabbitMQConsumer(onMessageCallback), 5000);
      });

      return { connection, channel };
    } catch (err) {
      console.warn(`[notification-rabbitmq] Connection attempt ${i + 1}/${retryCount} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  console.error('[notification-rabbitmq] Exhausted retries connecting to RabbitMQ.');
  return null;
}

module.exports = {
  startRabbitMQConsumer,
  QUEUE_NAME,
  EXCHANGE_NAME,
};

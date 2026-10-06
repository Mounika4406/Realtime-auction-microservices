# Real-Time Auction Microservices Platform

A production-ready, distributed, real-time auction platform designed with a microservices and event-driven architecture (EDA). The platform orchestrates 5 independent microservices, 3 isolated PostgreSQL database instances, and a RabbitMQ topic message broker, with automated health checking, container orchestration, and real-time WebSocket bidding updates.

---

## Architecture Overview

```mermaid
flowchart TD
    Client["Client (Web, Mobile, CLI)"]
    Gateway["API Gateway & Reverse Proxy (:8000)"]
    
    AuthSvc["Auth Service (:8001)"]
    AuctionSvc["Auction Service (:8002)"]
    BiddingSvc["Real-Time Bidding Service (:8003)"]
    NotifSvc["Notification Service (:8004)"]

    PGAuth[("Postgres Auth DB (:5432)")]
    PGAuction[("Postgres Auction DB (:5433)")]
    PGNotif[("Postgres Notification DB (:5434)")]
    RabbitMQ{{"RabbitMQ Topic Exchange\n'auction_events' (:5672)"}}

    %% External Connections
    Client -->|"HTTP /api/auth/*"| Gateway
    Client -->|"HTTP /api/auctions/*"| Gateway
    Client -->|"HTTP /api/notifications/*"| Gateway
    Client -->|"WS Upgrade /ws/auctions/:id?token=..."| Gateway

    %% Reverse Proxy Routing
    Gateway -->|"Reverse Proxy"| AuthSvc
    Gateway -->|"Reverse Proxy (Auth Enforced)"| AuctionSvc
    Gateway -->|"Reverse Proxy (Auth Enforced)"| NotifSvc
    Gateway -->|"Tunnel WS TCP Connection"| BiddingSvc

    %% Database-per-Service
    AuthSvc -->|"Read / Write Users"| PGAuth
    AuctionSvc -->|"Read / Write Auctions & Bids"| PGAuction
    NotifSvc -->|"Read / Write Alerts"| PGNotif

    %% Asynchronous Event Bus
    AuctionSvc -->|"Publish 'bid.placed'"| RabbitMQ
    RabbitMQ -->|"q_bidding_updates"| BiddingSvc
    RabbitMQ -->|"q_notification_generator"| NotifSvc

    %% Real-time push
    BiddingSvc -.->|"Push 'NEW_BID' to Room"| Client
```

### Key Architectural Patterns
1. **API Gateway Pattern**: Sole public entry point running on port `8000`. Centralizes cross-cutting concerns: route reverse proxying, CORS policy, edge JWT authentication verification, and WebSocket protocol upgrade tunneling (`Upgrade: websocket`).
2. **Database-per-Service Pattern**: Strict isolation between business domains. Dedicated PostgreSQL instances ensure that no service can query another service's tables directly.
3. **Atomic SQL Transactions**: Bidding logic utilizes PostgreSQL `SELECT ... FOR UPDATE` row-level locking to guarantee bid amounts strictly exceed current prices without race conditions.
4. **Event-Driven Architecture (EDA)**: RabbitMQ topic exchange `auction_events` decouples auction modifications from downstream consumers. Downstream services bind independent durable queues (`q_bidding_updates` and `q_notification_generator`) to the `bid.placed` routing key.
5. **Real-Time WebSocket Gateway**: Clients connect to `/ws/auctions/:auctionId?token=<jwt>`. Connections are segmented into isolated channels (rooms) by `auctionId`, pushing `NEW_BID` frames with sub-millisecond latency.
6. **Asynchronous User Alerts**: The Notification Service consumes `bid.placed`. When a previous bidder is outbid (`previous_bidder_id !== null`), an alert is persisted in `db_notification` without impacting the HTTP bid request latency.

---

## Microservices Topology & Port Allocations

| Container Name | Service Role | Internal Port | Exposed Host Port | Dependencies |
| :--- | :--- | :--- | :--- | :--- |
| `api-gateway` | Unified Reverse Proxy & Auth Guard | 8000 | `8000` | Backend services |
| `auth-service` | User Registration, Password Hash, JWT | 8001 | `8001` | `postgres-auth` |
| `auction-service` | Auction Lifecycle & Atomic Bidding | 8002 | `8002` | `postgres-auction`, `rabbitmq` |
| `bidding-service` | Real-Time WebSocket Rooms | 8003 | `8003` | `rabbitmq` |
| `notification-service`| Outbid Alert Generator & History | 8004 | `8004` | `postgres-notification`, `rabbitmq` |
| `postgres-auth` | Dedicated Database for Auth Domain | 5432 | `5432` | Volume seeds |
| `postgres-auction` | Dedicated Database for Auction Domain | 5432 | `5433` | Volume seeds |
| `postgres-notification`| Dedicated Database for Notifications | 5432 | `5434` | Volume seeds |
| `rabbitmq` | AMQP Message Broker & Management UI | 5672, 15672 | `5672`, `15672` | - |

---

## Prerequisites

- **Docker Desktop** (Engine v20+ with Docker Compose v2+)
- **Node.js** (v18+ LTS recommended for local testing)
- **Git**

---

## Getting Started

### 1. Clone & Configure Environment Variables
Copy the template configuration file:
```bash
cp .env.example .env
```

The default values in `.env` are preconfigured to work seamlessly out-of-the-box:
```env
JWT_SECRET=super_secret_auction_jwt_token_key_2026!
API_GATEWAY_PORT=8000

AUTH_DATABASE_URL=postgresql://postgres:postgres@postgres-auth:5432/db_auth
AUCTION_DATABASE_URL=postgresql://postgres:postgres@postgres-auction:5432/db_auction
NOTIFICATION_DATABASE_URL=postgresql://postgres:postgres@postgres-notification:5432/db_notification

RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
```

### 2. Boot the Platform with Docker Compose
Start all nine containers with health checks and volume seed mounts:
```bash
docker compose up --build -d
```

Check the health status of all running containers:
```bash
docker compose ps
```

All application services utilize `depends_on` with `condition: service_healthy` directives to guarantee they only boot after their respective PostgreSQL databases and RabbitMQ message broker have completed startup.

---

## Database Schemas & Automatic Seeding

Upon container initialization, PostgreSQL automatically executes the SQL scripts located in the host's `/seeds` directory mounted to `/docker-entrypoint-initdb.d`:

- **Auth Database (`db_auth`)**:
  - Table: `users` (`id`, `email`, `password`, `name`, `created_at`)
  - Pre-seeded users: `alice@example.com`, `bob@example.com`, `charlie@example.com` (Default password: `Password123!`)
- **Auction Database (`db_auction`)**:
  - Table: `auctions` (`id`, `title`, `description`, `starting_price`, `current_price`, `end_time`, `seller_id`, `created_at`)
  - Table: `bids` (`id`, `auction_id` FK, `user_id`, `amount`, `created_at`)
  - Pre-seeded active auction listings
- **Notification Database (`db_notification`)**:
  - Table: `notifications` (`id`, `user_id`, `message`, `is_read`, `created_at`)

---

## API Reference

All client HTTP requests should be routed through the **API Gateway** (`http://localhost:8000`).

### 1. Authentication Service

#### Register User
- **Route**: `POST /api/auth/register`
- **Access**: Public
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "Password123!",
  "name": "Jane Doe"
}
```
- **Response (201 Created)**:
```json
{
  "id": 1,
  "email": "user@example.com",
  "name": "Jane Doe"
}
```

#### Login User
- **Route**: `POST /api/auth/login`
- **Access**: Public
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "Password123!"
}
```
- **Response (200 OK)**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### 2. Auction Service

#### List Auctions
- **Route**: `GET /api/auctions`
- **Access**: Public
- **Response (200 OK)**: Array of active auctions.

#### Get Auction Details
- **Route**: `GET /api/auctions/:id`
- **Access**: Public
- **Response (200 OK)**: Auction details including bid history.

#### Create Auction Listing
- **Route**: `POST /api/auctions`
- **Access**: Protected (`Authorization: Bearer <token>`)
- **Request Body**:
```json
{
  "title": "Vintage Mechanical Watch",
  "description": "Mint condition 1970 chronograph.",
  "starting_price": 100.00,
  "end_time": "2026-12-31T23:59:59Z"
}
```
- **Response (201 Created)**: Created auction record with initialized `current_price` equal to `starting_price`.

#### Place Bid
- **Route**: `POST /api/auctions/:id/bids`
- **Access**: Protected (`Authorization: Bearer <token>`)
- **Request Body**:
```json
{
  "amount": 125.00
}
```
- **Response (201 Created)**:
```json
{
  "message": "Bid successfully placed.",
  "bid": {
    "id": 1,
    "auction_id": 1,
    "user_id": 2,
    "amount": 125.00,
    "created_at": "2026-10-06T10:00:00.000Z"
  },
  "auction": {
    "id": 1,
    "current_price": 125.00
  }
}
```
- **Failure (400 Bad Request)**: Returned if bid amount is less than or equal to current price.

---

### 3. Real-Time WebSocket Bidding Service

#### Connection Handshake
- **URL**: `ws://localhost:8000/ws/auctions/:auctionId?token=<JWT_TOKEN>`
- **Handshake Validation**: The Gateway proxies the upgrade to the Bidding Service. The Bidding Service extracts the token from the query parameter and cryptographically validates it. Connections with missing or invalid tokens are rejected with HTTP 401.
- **Initial Handshake Frame (Server -> Client)**:
```json
{
  "type": "CONNECTED",
  "payload": {
    "message": "Successfully connected to auction #1",
    "auctionId": "1",
    "userId": 2
  }
}
```

#### Real-Time Bid Broadcast (Server -> Client)
Triggered whenever a bid is successfully placed on that auction:
```json
{
  "type": "NEW_BID",
  "payload": {
    "auctionId": 1,
    "userId": 3,
    "newPrice": 150.00
  }
}
```

---

### 4. Notification Service

#### Get Notification History
- **Route**: `GET /api/notifications`
- **Access**: Protected (`Authorization: Bearer <token>`)
- **Response (200 OK)**:
```json
[
  {
    "id": 1,
    "message": "You have been outbid on auction #1! The new highest bid is $150.00.",
    "is_read": false,
    "created_at": "2026-10-06T10:05:00.000Z"
  }
]
```

---

## Testing & Verification

### Run Automated Test Suite
The repository includes unit and end-to-end integration tests that validate all 14 core specifications:

```bash
# Run all unit tests and integration tests
npm test

# Run microservice unit tests only
npm run test:unit

# Run end-to-end integration test suite
npm run test:integration
```

The test runner detects whether live Docker containers are currently running on port 8000:
- If live containers are found, tests run directly against the live environment.
- If live containers are not found, an in-memory test cluster spins up automatically to validate all routes, middlewares, transactions, WebSocket channels, and event consumers.

---

## RabbitMQ Management Dashboard

To inspect active queues (`q_bidding_updates`, `q_notification_generator`) and exchanges (`auction_events`):
- **URL**: `http://localhost:15672`
- **Default Username**: `guest`
- **Default Password**: `guest`

---

## Shutting Down the Stack

To cleanly stop and remove all containers and networks:
```bash
docker compose down
```

To remove all volumes (including database data):
```bash
docker compose down -v
```

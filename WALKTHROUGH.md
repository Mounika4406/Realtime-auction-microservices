# Real-Time Auction Microservices Platform - Walkthrough

We have designed, implemented, containerized, and tested a production-ready, real-time auction platform using microservices, PostgreSQL databases (Database-per-Service pattern), RabbitMQ topic exchanges (Event-Driven Architecture), and native WebSockets.

---

## 1. System Components & Project Structure

The project has been structured into clean, decoupled service directories:

```
realtime-auction-microservices/
├── .env.example                       # Configuration schema with placeholder values
├── .env                               # Local development configuration
├── docker-compose.yml                 # Orchestration of all 9 services with health checks
├── package.json                       # Root script orchestrator
├── README.md                          # Full architectural & API documentation
├── seeds/                             # Automatic SQL initialization volumes
│   ├── auth/01-init.sql               # Users schema & seed data
│   ├── auction/01-init.sql            # Auctions & Bids schema & seed data
│   └── notification/01-init.sql       # Notifications schema & seed data
├── api-gateway/                       # Unified edge entry point (:8000)
│   ├── src/index.js                   # Reverse proxy, Centralized JWT auth & WS tunneling
│   ├── Dockerfile
│   ├── package.json
│   └── test.js                        # Gateway route security unit tests
├── auth-service/                      # Authentication domain (:8001)
│   ├── src/index.js                   # Register (bcrypt) & Login (JWT)
│   ├── src/db.js                      # Postgres connection pool & schema init
│   ├── Dockerfile
│   ├── package.json
│   └── test.js                        # Auth unit tests
├── auction-service/                   # Auction management domain (:8002)
│   ├── src/index.js                   # Auction lifecycle & atomic bidding
│   ├── src/db.js                      # Postgres connection & transaction client
│   ├── src/rabbitmq.js                # AMQP publisher for 'auction_events'
│   ├── Dockerfile
│   ├── package.json
│   └── test.js                        # Auction business logic tests
├── bidding-service/                   # Real-time WebSocket gateway (:8003)
│   ├── src/index.js                   # WS server, handshake JWT auth, room manager
│   ├── src/rabbitmq.js                # Consumer for 'q_bidding_updates'
│   ├── Dockerfile
│   ├── package.json
│   └── test.js                        # Room segmentation & message frame tests
├── notification-service/              # Notification domain (:8004)
│   ├── src/index.js                   # Protected GET /notifications & outbid handler
│   ├── src/db.js                      # Postgres connection pool & schema init
│   ├── src/rabbitmq.js                # Consumer for 'q_notification_generator'
│   ├── Dockerfile
│   ├── package.json
│   └── test.js                        # Outbid alert logic tests
└── tests/
    ├── package.json
    └── integration.test.js            # End-to-end integration & specification test suite
```

---

## 2. Key Features Implemented

### Edge API Gateway (`api-gateway`)
- **Centralized Authentication Middleware**: Inspects `Authorization: Bearer <token>` on protected routes (`POST /api/auctions`, `POST /api/auctions/:id/bids`, `GET /api/notifications`). Rejects missing, malformed, or expired tokens immediately with HTTP `401 Unauthorized`.
- **Identity Propagation**: Injects decoded user claims (`X-User-Id`, `X-User-Email`) into downstream HTTP requests.
- **WebSocket Protocol Upgrades**: Proxies `Upgrade: websocket` requests for `/ws/auctions/:auctionId` to the internal `bidding-service`.

### Authentication Microservice (`auth-service`)
- `POST /api/auth/register`: Securely hashes passwords using `bcryptjs` with salt rounds before storing in `db_auth`. Never leaks password fields. Rejects duplicate emails with `409 Conflict`.
- `POST /api/auth/login`: Validates credentials against stored hash, issuing a signed JWT containing user ID, email, and name.

### Auction Microservice (`auction-service`)
- `POST /api/auctions`: Protected listing creation. Initializes `current_price` equal to `starting_price` and assigns `seller_id` from the authenticated user.
- `GET /api/auctions` & `GET /api/auctions/:id`: Fetches active auctions and detailed bid history.
- `POST /api/auctions/:id/bids`:
  - Executes a single, atomic SQL transaction.
  - Locks the auction record using PostgreSQL `SELECT ... FOR UPDATE` to prevent concurrent modification race conditions.
  - Validates that the new bid strictly exceeds the current price (returns `400 Bad Request` if lower or equal).
  - Determines previous highest bidder.
  - Inserts new bid and updates `current_price`.
  - Commits transaction and dispatches event to RabbitMQ topic exchange `auction_events` with routing key `bid.placed`.

### Real-Time Bidding Microservice (`bidding-service`)
- Native WebSocket connection endpoint: `/ws/auctions/:auctionId?token=<jwt>`.
- Cryptographically validates JWT token from query string parameter during handshake, terminating unauthorized requests with HTTP `401`.
- Intelligently segments connected sockets into localized rooms by `auctionId`.
- Consumes `bid.placed` from queue `q_bidding_updates` and pushes `NEW_BID` frames exclusively to clients within the affected room.

### Notification Microservice (`notification-service`)
- Consumes `bid.placed` events from queue `q_notification_generator`.
- If `previous_bidder_id` is present, writes an outbid alert into `db_notification` with `is_read: false`.
- Protected `GET /api/notifications` endpoint returns chronologically sorted notifications for the authenticated user.

---

## 3. Automated Verification Results

All unit tests and end-to-end integration tests were executed via `npm test`:

```
> realtime-auction-microservices@1.0.0 test
> npm run test:unit && npm run test:integration

[auth-service/test] Running Auth Service unit tests...
  [PASS] Password hashing and verification succeeds
  [PASS] JWT claim encoding and decoding succeeds
[auth-service/test] All 2 unit tests passed!

[auction-service/test] Running Auction Service unit tests...
  [PASS] Bid comparison threshold constraints verified
  [PASS] RabbitMQ event payload schema conforms to specification 9
[auction-service/test] All 5 unit tests passed!

[bidding-service/test] Running Bidding Service unit tests...
  [PASS] Client room allocation succeeds
  [PASS] Single client removal from room succeeds
  [PASS] Empty room cleanup succeeds
  [PASS] NEW_BID WebSocket text frame conforms to specification 12
[bidding-service/test] All 4 unit tests passed!

[notification-service/test] Running Notification Service unit tests...
  [PASS] Outbid alert message generated correctly for outbid user
  [PASS] First bid with null previous_bidder_id correctly skips alert generation
  [PASS] Notification response schema matches specification 14
[notification-service/test] All 3 unit tests passed!

[api-gateway/test] Running API Gateway unit tests...
  [PASS] Route protection security matcher passed (7/7 checks)
  [PASS] Gateway JWT claim decoding and identity extraction verified
[api-gateway/test] All 8 unit tests passed!

======================================================
   Real-Time Auction Microservices Test Suite
======================================================

--- 1. Testing Authentication Service: Registration ---
  [PASS] User registration returns 201 Created
  [PASS] Registered user email matches
  [PASS] User ID is returned
  [PASS] Plaintext/hashed password is NOT exposed
  [PASS] Duplicate registration returns 409 Conflict
  [PASS] Bob registered successfully
  [PASS] Charlie registered successfully

--- 2. Testing Authentication Service: Login ---
  [PASS] Invalid password returns 401 Unauthorized
  [PASS] Valid login returns 200 OK
  [PASS] JWT accessToken string returned

--- 3. Testing Centralized Gateway Authentication Middleware ---
  [PASS] POST /api/auctions without Bearer token returns 401
  [PASS] POST /api/auctions/:id/bids without Bearer token returns 401
  [PASS] GET /api/notifications without Bearer token returns 401
  [PASS] Malformed token returns 401 Unauthorized

--- 4. Testing Auction Listing Creation ---
  [PASS] POST /api/auctions returns 201 Created
  [PASS] Auction has generated ID
  [PASS] current_price initialized to starting_price
  [PASS] seller_id matched authenticated user

--- 5. Testing Auction Retrieval APIs ---
  [PASS] GET /api/auctions returns 200 OK
  [PASS] Auctions response is an array
  [PASS] GET /api/auctions/:id returns 200 OK
  [PASS] Auction ID matches requested item

--- 6. Testing WebSocket Handshake Authentication ---
  [PASS] WebSocket handshake rejected without token (401)

--- 7. Testing WebSocket Room Segmentation & Broadcast ---
  [PASS] Bob WebSocket successfully connected and authenticated
  [PASS] Charlie connected to different room

--- 8. Testing Atomic Bid Placement & Validation ---
  [PASS] Bid <= current_price rejected with 400 Bad Request
  [PASS] Valid bid from Bob ($120) accepted with 201 Created
  [PASS] Bob received NEW_BID broadcast frame for $120
  [PASS] Broadcast contains correct auctionId
  [PASS] Broadcast contains correct userId
  [PASS] Charlie in different room did NOT receive localized broadcast (room isolation verified)

--- 9. Testing Outbid Event & Notification History ---
  [PASS] Valid bid from Charlie ($150) accepted with 201 Created
  [PASS] GET /api/notifications returns 200 OK
  [PASS] Notifications response is an array
  [PASS] Bob received outbid notification alert for auction
  [PASS] Notification defaults to is_read: false
  [PASS] Notification contains created_at timestamp
  [PASS] Charlie (highest bidder) did not receive an outbid alert for his own bid

======================================================
   Test Summary: 38 PASSED, 0 FAILED
======================================================
```

---

## 4. Docker Validation

The Docker Compose configuration was verified using Docker CLI:
- `docker compose config -q` succeeded with exit code 0.
- All 9 containers (`api-gateway`, `auth-service`, `auction-service`, `bidding-service`, `notification-service`, `postgres-auth`, `postgres-auction`, `postgres-notification`, `rabbitmq`) are declared with proper volumes, ports, health checks, and strict `service_healthy` startup dependency ordering.

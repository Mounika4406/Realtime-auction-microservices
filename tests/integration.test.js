const http = require('http');
const url = require('url');
const { WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_auction_jwt_token_key_2026!';
const LIVE_GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';

// Helper to make HTTP requests
function httpRequest(targetUrl, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(reqOptions, (res) => {
      let rawData = '';
      res.on('data', (chunk) => {
        rawData += chunk;
      });
      res.on('end', () => {
        let parsedData = rawData;
        try {
          parsedData = JSON.parse(rawData);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsedData,
          raw: rawData,
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Check if live server is reachable
async function isLiveReachable(endpointUrl) {
  try {
    const res = await httpRequest(`${endpointUrl}/health`);
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

// In-Memory Test Harness if Docker / live containers are not active
async function setupTestCluster() {
  console.log('[test-cluster] Live gateway not detected. Initializing self-contained in-memory cluster...');

  // Mock databases
  const authDb = { users: [], nextId: 1 };
  const auctionDb = { auctions: [], bids: [], nextAuctionId: 1, nextBidId: 1 };
  const notifDb = { notifications: [], nextId: 1 };

  // Mock message broker topic exchange 'auction_events'
  const eventBus = {
    subscribers: [],
    subscribe(queueName, routingKey, cb) {
      this.subscribers.push({ queueName, routingKey, cb });
    },
    publish(exchange, routingKey, payload) {
      for (const sub of this.subscribers) {
        if (sub.routingKey === routingKey || sub.routingKey === '#') {
          setTimeout(() => sub.cb(payload), 10);
        }
      }
    },
  };

  // 1. Mock Auth Service
  const express = require('express');
  const cors = require('cors');
  const bcrypt = require('bcryptjs');

  const authApp = express();
  authApp.use(cors());
  authApp.use(express.json());

  authApp.post(['/register', '/api/auth/register'], async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const cleanEmail = email.toLowerCase().trim();
    if (authDb.users.some((u) => u.email === cleanEmail)) {
      return res.status(409).json({ error: 'User exists' });
    }
    const hash = await bcrypt.hash(password, 8);
    const user = { id: authDb.nextId++, email: cleanEmail, password: hash, name: name.trim() };
    authDb.users.push(user);
    res.status(201).json({ id: user.id, email: user.email, name: user.name });
  });

  authApp.post(['/login', '/api/auth/login'], async (req, res) => {
    const { email, password } = req.body;
    const user = authDb.users.find((u) => u.email === email?.toLowerCase().trim());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ accessToken: token });
  });

  const authServer = authApp.listen(9001);

  // 2. Mock Auction Service
  const auctionApp = express();
  auctionApp.use(cors());
  auctionApp.use(express.json());

  function getUser(req) {
    if (req.headers['x-user-id']) {
      return { id: parseInt(req.headers['x-user-id'], 10), email: req.headers['x-user-email'] };
    }
    if (req.headers.authorization?.startsWith('Bearer ')) {
      try {
        return jwt.verify(req.headers.authorization.slice(7), JWT_SECRET);
      } catch {
        return null;
      }
    }
    return null;
  }

  auctionApp.get(['/', '/auctions', '/api/auctions'], (req, res) => {
    res.status(200).json(auctionDb.auctions);
  });

  auctionApp.get(['/:id', '/auctions/:id', '/api/auctions/:id'], (req, res) => {
    const a = auctionDb.auctions.find((item) => item.id === parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'Not found' });
    const bids = auctionDb.bids.filter((b) => b.auction_id === a.id);
    res.status(200).json({ ...a, bids });
  });

  auctionApp.post(['/', '/auctions', '/api/auctions'], (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { title, description, starting_price, end_time } = req.body;
    if (!title || starting_price === undefined || !end_time) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const a = {
      id: auctionDb.nextAuctionId++,
      title,
      description: description || '',
      starting_price: Number(starting_price),
      current_price: Number(starting_price),
      end_time,
      seller_id: user.id,
      created_at: new Date().toISOString(),
    };
    auctionDb.auctions.push(a);
    res.status(201).json(a);
  });

  auctionApp.post(['/:id/bids', '/auctions/:id/bids', '/api/auctions/:id/bids'], (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const auctionId = parseInt(req.params.id, 10);
    const a = auctionDb.auctions.find((item) => item.id === auctionId);
    if (!a) return res.status(404).json({ error: 'Auction not found' });

    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount <= a.current_price) {
      return res.status(400).json({ error: 'Bid amount must be strictly greater than current price.' });
    }

    const prevBids = auctionDb.bids.filter((b) => b.auction_id === auctionId);
    const prevBid = prevBids.length > 0 ? prevBids[prevBids.length - 1] : null;
    const previousBidderId = prevBid ? prevBid.user_id : null;
    const previousPrice = a.current_price;

    const bid = {
      id: auctionDb.nextBidId++,
      auction_id: auctionId,
      user_id: user.id,
      amount,
      created_at: new Date().toISOString(),
    };
    auctionDb.bids.push(bid);
    a.current_price = amount;

    // Publish event
    eventBus.publish('auction_events', 'bid.placed', {
      auction_id: auctionId,
      user_id: user.id,
      new_price: amount,
      previous_price: previousPrice,
      previous_bidder_id: previousBidderId,
    });

    res.status(201).json({ message: 'Bid placed', bid, auction: a });
  });

  const auctionServer = auctionApp.listen(9002);

  // 3. Mock Bidding Service (WebSocket)
  const biddingApp = express();
  biddingApp.use(cors());
  const biddingHttp = http.createServer(biddingApp);
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  const wsRooms = new Map();

  biddingHttp.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);
    const m = parsed.pathname.match(/^\/ws\/auctions\/([^/?#]+)/);
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    const token = parsed.query.token;
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = decoded;
        ws.auctionId = m[1];
        wss.emit('connection', ws);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const id = String(ws.auctionId);
    if (!wsRooms.has(id)) wsRooms.set(id, new Set());
    wsRooms.get(id).add(ws);

    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { auctionId: ws.auctionId, userId: ws.user.id } }));

    ws.on('close', () => {
      wsRooms.get(id)?.delete(ws);
    });
  });

  eventBus.subscribe('q_bidding_updates', 'bid.placed', (payload) => {
    const clients = wsRooms.get(String(payload.auction_id));
    if (clients) {
      const msg = JSON.stringify({
        type: 'NEW_BID',
        payload: {
          auctionId: Number(payload.auction_id),
          userId: Number(payload.user_id),
          newPrice: Number(payload.new_price),
        },
      });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    }
  });

  const biddingServer = biddingHttp.listen(9003);

  // 4. Mock Notification Service
  const notifApp = express();
  notifApp.use(cors());
  notifApp.use(express.json());

  notifApp.get(['/', '/notifications', '/api/notifications'], (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const list = notifDb.notifications
      .filter((n) => n.user_id === user.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.status(200).json(list);
  });

  eventBus.subscribe('q_notification_generator', 'bid.placed', (payload) => {
    if (payload.previous_bidder_id !== null && payload.previous_bidder_id !== undefined) {
      notifDb.notifications.push({
        id: notifDb.nextId++,
        user_id: payload.previous_bidder_id,
        message: `You have been outbid on auction #${payload.auction_id}! The new highest bid is $${Number(payload.new_price).toFixed(2)}.`,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    }
  });

  const notifServer = notifApp.listen(9004);

  // 5. Gateway with Centralized Auth Middleware & Proxying
  const httpProxy = require('http-proxy');
  const gatewayApp = express();
  gatewayApp.use(cors());

  const proxy = httpProxy.createProxyServer({ ws: true });

  function isProtected(method, path) {
    const clean = path.replace(/\/+$/, '');
    const m = method.toUpperCase();
    if (m === 'POST' && (clean === '/api/auctions' || clean === '/auctions')) return true;
    if (m === 'POST' && (/^\/api\/auctions\/[^/]+\/bids$/.test(clean) || /^\/auctions\/[^/]+\/bids$/.test(clean))) return true;
    if (m === 'GET' && (clean === '/api/notifications' || clean === '/notifications')) return true;
    return false;
  }

  gatewayApp.use((req, res, next) => {
    if (isProtected(req.method, req.path)) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header with Bearer token.' });
      }
      try {
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        req.headers['x-user-id'] = String(decoded.id);
        req.headers['x-user-email'] = decoded.email || '';
        return next();
      } catch (err) {
        return res.status(401).json({ error: `Unauthorized: Invalid or expired token (${err.message}).` });
      }
    }
    next();
  });

  gatewayApp.use(['/api/auth', '/auth'], (req, res) => {
    proxy.web(req, res, { target: 'http://127.0.0.1:9001' });
  });

  gatewayApp.use(['/api/auctions', '/auctions'], (req, res) => {
    proxy.web(req, res, { target: 'http://127.0.0.1:9002' });
  });

  gatewayApp.use(['/api/notifications', '/notifications'], (req, res) => {
    proxy.web(req, res, { target: 'http://127.0.0.1:9004' });
  });

  gatewayApp.get('/health', (req, res) => res.json({ status: 'ok' }));

  const gatewayHttp = http.createServer(gatewayApp);
  gatewayHttp.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws/auctions/')) {
      proxy.ws(req, socket, head, { target: 'http://127.0.0.1:9003' });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  const gatewayServer = gatewayHttp.listen(9000);

  return {
    gatewayUrl: 'http://127.0.0.1:9000',
    wsUrl: 'ws://127.0.0.1:9000',
    close: () => {
      gatewayServer.close();
      notifServer.close();
      biddingServer.close();
      auctionServer.close();
      authServer.close();
    },
  };
}

// Main Test Execution
async function runTests() {
  console.log('\n======================================================');
  console.log('   Real-Time Auction Microservices Test Suite');
  console.log('======================================================\n');

  let cluster = null;
  let baseUrl = LIVE_GATEWAY_URL;
  let wsBaseUrl = LIVE_GATEWAY_URL.replace('http', 'ws');

  const live = await isLiveReachable(LIVE_GATEWAY_URL);
  if (live) {
    console.log(`[test] Connected to LIVE API Gateway at ${LIVE_GATEWAY_URL}`);
  } else {
    cluster = await setupTestCluster();
    baseUrl = cluster.gatewayUrl;
    wsBaseUrl = cluster.wsUrl;
    console.log(`[test] Running test suite against test cluster at ${baseUrl}`);
  }

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // -----------------------------------------------------------------
    // TEST 1: User Registration (Spec 4)
    // -----------------------------------------------------------------
    console.log('\n--- 1. Testing Authentication Service: Registration ---');
    const userAliceEmail = `alice_${Date.now()}@example.com`;
    const regAlice = await httpRequest(`${baseUrl}/api/auth/register`, { method: 'POST' }, {
      email: userAliceEmail,
      password: 'Password123!',
      name: 'Alice Seller',
    });
    assert(regAlice.statusCode === 201, 'User registration returns 201 Created');
    assert(regAlice.data.email === userAliceEmail, 'Registered user email matches');
    assert(regAlice.data.id !== undefined, 'User ID is returned');
    assert(regAlice.data.password === undefined, 'Plaintext/hashed password is NOT exposed');

    // Duplicate email registration rejected
    const dupAlice = await httpRequest(`${baseUrl}/api/auth/register`, { method: 'POST' }, {
      email: userAliceEmail,
      password: 'Password123!',
      name: 'Alice Again',
    });
    assert(dupAlice.statusCode === 409, 'Duplicate registration returns 409 Conflict');

    // Register Bob & Charlie
    const userBobEmail = `bob_${Date.now()}@example.com`;
    const regBob = await httpRequest(`${baseUrl}/api/auth/register`, { method: 'POST' }, {
      email: userBobEmail,
      password: 'Password123!',
      name: 'Bob Bidder',
    });
    assert(regBob.statusCode === 201, 'Bob registered successfully');

    const userCharlieEmail = `charlie_${Date.now()}@example.com`;
    const regCharlie = await httpRequest(`${baseUrl}/api/auth/register`, { method: 'POST' }, {
      email: userCharlieEmail,
      password: 'Password123!',
      name: 'Charlie Bidder',
    });
    assert(regCharlie.statusCode === 201, 'Charlie registered successfully');

    // -----------------------------------------------------------------
    // TEST 2: User Login & JWT Generation (Spec 4)
    // -----------------------------------------------------------------
    console.log('\n--- 2. Testing Authentication Service: Login ---');
    const loginFail = await httpRequest(`${baseUrl}/api/auth/login`, { method: 'POST' }, {
      email: userAliceEmail,
      password: 'WrongPassword!',
    });
    assert(loginFail.statusCode === 401, 'Invalid password returns 401 Unauthorized');

    const loginAlice = await httpRequest(`${baseUrl}/api/auth/login`, { method: 'POST' }, {
      email: userAliceEmail,
      password: 'Password123!',
    });
    assert(loginAlice.statusCode === 200, 'Valid login returns 200 OK');
    assert(typeof loginAlice.data.accessToken === 'string', 'JWT accessToken string returned');
    const aliceToken = loginAlice.data.accessToken;

    const loginBob = await httpRequest(`${baseUrl}/api/auth/login`, { method: 'POST' }, {
      email: userBobEmail,
      password: 'Password123!',
    });
    const bobToken = loginBob.data.accessToken;

    const loginCharlie = await httpRequest(`${baseUrl}/api/auth/login`, { method: 'POST' }, {
      email: userCharlieEmail,
      password: 'Password123!',
    });
    const charlieToken = loginCharlie.data.accessToken;

    // -----------------------------------------------------------------
    // TEST 3: API Gateway Centralized Auth Middleware (Spec 5)
    // -----------------------------------------------------------------
    console.log('\n--- 3. Testing Centralized Gateway Authentication Middleware ---');
    const unauthAuction = await httpRequest(`${baseUrl}/api/auctions`, { method: 'POST' }, {
      title: 'Hacked Item',
      starting_price: 100,
      end_time: new Date(Date.now() + 86400000).toISOString(),
    });
    assert(unauthAuction.statusCode === 401, 'POST /api/auctions without Bearer token returns 401');

    const unauthBid = await httpRequest(`${baseUrl}/api/auctions/1/bids`, { method: 'POST' }, {
      amount: 500,
    });
    assert(unauthBid.statusCode === 401, 'POST /api/auctions/:id/bids without Bearer token returns 401');

    const unauthNotifs = await httpRequest(`${baseUrl}/api/notifications`, { method: 'GET' });
    assert(unauthNotifs.statusCode === 401, 'GET /api/notifications without Bearer token returns 401');

    const malformedToken = await httpRequest(`${baseUrl}/api/notifications`, {
      method: 'GET',
      headers: { Authorization: 'Bearer this.is.invalid' },
    });
    assert(malformedToken.statusCode === 401, 'Malformed token returns 401 Unauthorized');

    // -----------------------------------------------------------------
    // TEST 4: Auction Listing Creation (Spec 7)
    // -----------------------------------------------------------------
    console.log('\n--- 4. Testing Auction Listing Creation ---');
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();
    const createAuction = await httpRequest(
      `${baseUrl}/api/auctions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}` },
      },
      {
        title: 'Rare Cyberpunk Concept Art #101',
        description: 'Original concept art signed by developers',
        starting_price: 100.0,
        end_time: futureDate,
      }
    );
    assert(createAuction.statusCode === 201, 'POST /api/auctions returns 201 Created');
    assert(createAuction.data.id !== undefined, 'Auction has generated ID');
    assert(Number(createAuction.data.current_price) === 100.0, 'current_price initialized to starting_price');
    assert(createAuction.data.seller_id === regAlice.data.id, 'seller_id matched authenticated user');
    const auctionId = createAuction.data.id;

    // -----------------------------------------------------------------
    // TEST 5: Fetch Auctions & Details (Spec 6)
    // -----------------------------------------------------------------
    console.log('\n--- 5. Testing Auction Retrieval APIs ---');
    const getAuctions = await httpRequest(`${baseUrl}/api/auctions`);
    assert(getAuctions.statusCode === 200, 'GET /api/auctions returns 200 OK');
    assert(Array.isArray(getAuctions.data), 'Auctions response is an array');

    const getAuction = await httpRequest(`${baseUrl}/api/auctions/${auctionId}`);
    assert(getAuction.statusCode === 200, 'GET /api/auctions/:id returns 200 OK');
    assert(getAuction.data.id === auctionId, 'Auction ID matches requested item');

    // -----------------------------------------------------------------
    // TEST 6: WebSocket Handshake Authentication (Spec 10)
    // -----------------------------------------------------------------
    console.log('\n--- 6. Testing WebSocket Handshake Authentication ---');
    const testWsAuth = () => {
      return new Promise((resolve) => {
        // Attempt connect without token
        const badWs = new WebSocket(`${wsBaseUrl}/ws/auctions/${auctionId}`);
        badWs.on('open', () => {
          assert(false, 'WebSocket connected without token (should fail)');
          badWs.close();
          resolve();
        });
        badWs.on('error', (err) => {
          assert(true, 'WebSocket handshake rejected without token (401)');
          resolve();
        });
      });
    };
    await testWsAuth();

    // -----------------------------------------------------------------
    // TEST 7: WebSocket Rooms & Real-Time Broadcast (Spec 11 & 12)
    // -----------------------------------------------------------------
    console.log('\n--- 7. Testing WebSocket Room Segmentation & Broadcast ---');
    const bobWsMessages = [];
    const charlieOtherRoomMessages = [];

    // Bob connects to auction room
    const bobWs = new WebSocket(`${wsBaseUrl}/ws/auctions/${auctionId}?token=${bobToken}`);
    await new Promise((resolve) => {
      bobWs.on('open', resolve);
    });
    bobWs.on('message', (data) => {
      try {
        bobWsMessages.push(JSON.parse(data.toString()));
      } catch {}
    });

    // Charlie connects to a DIFFERENT auction room (999999)
    const charlieWs = new WebSocket(`${wsBaseUrl}/ws/auctions/999999?token=${charlieToken}`);
    await new Promise((resolve) => {
      charlieWs.on('open', resolve);
    });
    charlieWs.on('message', (data) => {
      try {
        charlieOtherRoomMessages.push(JSON.parse(data.toString()));
      } catch {}
    });

    assert(bobWs.readyState === WebSocket.OPEN, 'Bob WebSocket successfully connected and authenticated');
    assert(charlieWs.readyState === WebSocket.OPEN, 'Charlie connected to different room');

    // -----------------------------------------------------------------
    // TEST 8: Atomic Bid Placement (Spec 8 & 9)
    // -----------------------------------------------------------------
    console.log('\n--- 8. Testing Atomic Bid Placement & Validation ---');
    // Bid lower than current price ($100) -> 400 Bad Request
    const lowBid = await httpRequest(
      `${baseUrl}/api/auctions/${auctionId}/bids`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      },
      { amount: 90.0 }
    );
    assert(lowBid.statusCode === 400, 'Bid <= current_price rejected with 400 Bad Request');

    // Valid bid from Bob ($120)
    const validBid1 = await httpRequest(
      `${baseUrl}/api/auctions/${auctionId}/bids`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      },
      { amount: 120.0 }
    );
    assert(validBid1.statusCode === 201, 'Valid bid from Bob ($120) accepted with 201 Created');

    // Wait 100ms for event propagation
    await new Promise((r) => setTimeout(r, 150));

    // Check Bob received NEW_BID broadcast
    const bobBid1Msg = bobWsMessages.find(
      (m) => m.type === 'NEW_BID' && m.payload?.newPrice === 120
    );
    assert(bobBid1Msg !== undefined, 'Bob received NEW_BID broadcast frame for $120');
    assert(bobBid1Msg?.payload?.auctionId === Number(auctionId), 'Broadcast contains correct auctionId');
    assert(bobBid1Msg?.payload?.userId === Number(regBob.data.id), 'Broadcast contains correct userId');

    // Verify Charlie in DIFFERENT room did NOT receive this message
    const charlieReceivedBobBid = charlieOtherRoomMessages.find(
      (m) => m.type === 'NEW_BID' && m.payload?.newPrice === 120
    );
    assert(!charlieReceivedBobBid, 'Charlie in different room did NOT receive localized broadcast (room isolation verified)');

    // -----------------------------------------------------------------
    // TEST 9: Outbid Notification Processing (Spec 13 & 14)
    // -----------------------------------------------------------------
    console.log('\n--- 9. Testing Outbid Event & Notification History ---');
    // Charlie places higher bid ($150) -> Outbids Bob!
    const validBid2 = await httpRequest(
      `${baseUrl}/api/auctions/${auctionId}/bids`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${charlieToken}` },
      },
      { amount: 150.0 }
    );
    assert(validBid2.statusCode === 201, 'Valid bid from Charlie ($150) accepted with 201 Created');

    // Wait 250ms for asynchronous message processing
    await new Promise((r) => setTimeout(r, 250));

    // Bob queries his notifications
    const bobNotifs = await httpRequest(`${baseUrl}/api/notifications`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert(bobNotifs.statusCode === 200, 'GET /api/notifications returns 200 OK');
    assert(Array.isArray(bobNotifs.data), 'Notifications response is an array');

    const outbidAlert = bobNotifs.data.find(
      (n) => n.message && n.message.includes(`auction #${auctionId}`) && n.message.includes('150')
    );
    assert(outbidAlert !== undefined, 'Bob received outbid notification alert for auction');
    assert(outbidAlert?.is_read === false, 'Notification defaults to is_read: false');
    assert(outbidAlert?.created_at !== undefined, 'Notification contains created_at timestamp');

    // Charlie (the highest bidder) queries notifications
    const charlieNotifs = await httpRequest(`${baseUrl}/api/notifications`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${charlieToken}` },
    });
    const charlieOutbid = charlieNotifs.data.find(
      (n) => n.message && n.message.includes(`auction #${auctionId}`)
    );
    assert(!charlieOutbid, 'Charlie (highest bidder) did not receive an outbid alert for his own bid');

    bobWs.close();
    charlieWs.close();
  } catch (err) {
    console.error('[test] Unexpected error during test execution:', err);
    failed++;
  } finally {
    if (cluster) {
      cluster.close();
    }
  }

  console.log('\n======================================================');
  console.log(`   Test Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();

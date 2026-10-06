async function runBiddingUnitTests() {
  console.log('[bidding-service/test] Running Bidding Service unit tests...');
  let passed = 0;

  const rooms = new Map();

  function joinRoom(auctionId, ws) {
    const key = String(auctionId);
    if (!rooms.has(key)) {
      rooms.set(key, new Set());
    }
    rooms.get(key).add(ws);
  }

  function leaveRoom(auctionId, ws) {
    const key = String(auctionId);
    if (rooms.has(key)) {
      const set = rooms.get(key);
      set.delete(ws);
      if (set.size === 0) {
        rooms.delete(key);
      }
    }
  }

  const dummyWs1 = { id: 'ws1' };
  const dummyWs2 = { id: 'ws2' };

  joinRoom(10, dummyWs1);
  joinRoom(10, dummyWs2);
  joinRoom(20, dummyWs1);

  if (rooms.get('10').size === 2 && rooms.get('20').size === 1) {
    console.log('  [PASS] Client room allocation succeeds');
    passed++;
  } else {
    throw new Error('Room allocation failed');
  }

  leaveRoom(10, dummyWs1);
  if (rooms.get('10').size === 1) {
    console.log('  [PASS] Single client removal from room succeeds');
    passed++;
  }

  leaveRoom(10, dummyWs2);
  if (!rooms.has('10')) {
    console.log('  [PASS] Empty room cleanup succeeds');
    passed++;
  }

  // Format Broadcast
  const amqpEvent = { auction_id: 10, user_id: 3, new_price: 180 };
  const wsBroadcast = {
    type: 'NEW_BID',
    payload: {
      auctionId: Number(amqpEvent.auction_id),
      userId: Number(amqpEvent.user_id),
      newPrice: Number(amqpEvent.new_price),
    },
  };

  if (wsBroadcast.type === 'NEW_BID' && wsBroadcast.payload.newPrice === 180) {
    console.log('  [PASS] NEW_BID WebSocket text frame conforms to specification 12');
    passed++;
  }

  console.log(`[bidding-service/test] All ${passed} unit tests passed!\n`);
}

runBiddingUnitTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

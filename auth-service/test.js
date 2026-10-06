const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test_secret_key_123';

async function runAuthUnitTests() {
  console.log('[auth-service/test] Running Auth Service unit tests...');
  let passed = 0;

  // 1. Password hashing test
  const password = 'SecurePassword2026!';
  const hash = await bcrypt.hash(password, 10);
  if (await bcrypt.compare(password, hash) && !(await bcrypt.compare('WrongPassword', hash))) {
    console.log('  [PASS] Password hashing and verification succeeds');
    passed++;
  } else {
    throw new Error('Password hash comparison failed');
  }

  // 2. JWT Generation & Verification
  const user = { id: 42, email: 'tester@example.com', name: 'Tester' };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.id === 42 && decoded.email === 'tester@example.com') {
    console.log('  [PASS] JWT claim encoding and decoding succeeds');
    passed++;
  } else {
    throw new Error('JWT verification failed');
  }

  console.log(`[auth-service/test] All ${passed} unit tests passed!\n`);
}

runAuthUnitTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

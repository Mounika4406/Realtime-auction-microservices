-- Auth Database Schema & Initial Data
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pre-seed test users
-- Password for all pre-seeded test users is: Password123!
-- Standard bcrypt hash ($2a$10$wT0o3s/f2ZqK/U7N0eE2yOGzC758yKq0HkZ47D2dsm3c2yT5B8D8G)
INSERT INTO users (email, password, name)
VALUES 
    ('alice@example.com', '$2a$10$wT0o3s/f2ZqK/U7N0eE2yOGzC758yKq0HkZ47D2dsm3c2yT5B8D8G', 'Alice Seller'),
    ('bob@example.com', '$2a$10$wT0o3s/f2ZqK/U7N0eE2yOGzC758yKq0HkZ47D2dsm3c2yT5B8D8G', 'Bob Bidder'),
    ('charlie@example.com', '$2a$10$wT0o3s/f2ZqK/U7N0eE2yOGzC758yKq0HkZ47D2dsm3c2yT5B8D8G', 'Charlie Bidder')
ON CONFLICT (email) DO NOTHING;

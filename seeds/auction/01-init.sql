-- Auction Database Schema & Initial Data
CREATE TABLE IF NOT EXISTS auctions (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    starting_price NUMERIC(12, 2) NOT NULL,
    current_price NUMERIC(12, 2) NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    seller_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bids (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial test auctions
INSERT INTO auctions (title, description, starting_price, current_price, end_time, seller_id)
VALUES
    ('Vintage 1970 Mechanical Watch', 'Rare classic vintage wristwatch in pristine working condition.', 100.00, 100.00, NOW() + INTERVAL '7 days', 1),
    ('Signed Cyberpunk Concept Art', 'Limited edition archival art print signed by the lead concept artist.', 50.00, 50.00, NOW() + INTERVAL '3 days', 1),
    ('Antique Brass Telescope', '19th century maritime brass telescope with original mahogany tripod.', 250.00, 250.00, NOW() + INTERVAL '14 days', 1)
ON CONFLICT DO NOTHING;

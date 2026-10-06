-- Notification Database Schema & Initial Data
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial test notification
INSERT INTO notifications (user_id, message, is_read, created_at)
VALUES
    (2, 'Welcome to the Real-Time Auction platform!', FALSE, NOW() - INTERVAL '1 hour')
ON CONFLICT DO NOTHING;

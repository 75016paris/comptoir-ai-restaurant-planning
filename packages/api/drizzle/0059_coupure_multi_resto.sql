-- Worker preferences: willing to accept split shifts (coupure) and to work at another restaurant.
-- Both default to false. Written by the worker from /my-profile; read by the owner in /staff/:id and by the autoscheduler.
ALTER TABLE users ADD COLUMN coupure_willing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN multi_restaurant_willing INTEGER NOT NULL DEFAULT 1;

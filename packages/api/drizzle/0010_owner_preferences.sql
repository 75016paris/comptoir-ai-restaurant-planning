-- Owner preferences on restaurant
ALTER TABLE restaurants ADD COLUMN swap_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN notify_on_swap INTEGER NOT NULL DEFAULT 1;
ALTER TABLE restaurants ADD COLUMN tap_in_out_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE restaurants ADD COLUMN reminder_frequency TEXT NOT NULL DEFAULT 'off';

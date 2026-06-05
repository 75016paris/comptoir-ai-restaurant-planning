-- WhatsApp bot system-prompt + tool-description language preference per restaurant.
-- Independent from the admin's UI language (a French operator may run a PT-speaking bot
-- for a Portuguese workforce, etc). Bot prompts are FR-only at the moment — multi-language
-- prompt/tool catalogs remain a follow-up item.
ALTER TABLE restaurants ADD COLUMN whatsapp_bot_locale TEXT NOT NULL DEFAULT 'fr';

-- Stores JSON array of disabled compliance rule codes, e.g. ["HCR-L3121-18", "HCR-L3132-2"]
ALTER TABLE restaurants ADD COLUMN disabled_compliance_rules TEXT NOT NULL DEFAULT '[]';

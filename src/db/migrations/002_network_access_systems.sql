-- ============================================================
-- MIGRĀCIJA 002 — palaist TIKAI, ja datubāze jau iepriekš izveidota.
-- Pievieno tīkla piekļuves veidus (WiFi paveidi, VPN pa ierīces tipu),
-- lai darbiniekiem tos varētu piešķirt un vēlāk izvēlēties no saraksta,
-- veidojot ticketu.
-- ============================================================

INSERT INTO access_systems (code, name, description) VALUES
    ('wifi_main',    'WiFi (galvenais)',        'Uznemuma galvenais WiFi tikls darbiniekiem'),
    ('wifi_guest',   'WiFi (viesu)',             'Viesu WiFi tikls'),
    ('wifi_iot',     'WiFi (IoT ierices)',       'Atsevisks WiFi tikls IoT/viedajam ierices'),
    ('vpn_computer', 'VPN (dators)',             'VPN piekluve no darba/personigā datora'),
    ('vpn_phone',    'VPN (telefons)',           'VPN piekluve no mobila telefona')
ON CONFLICT (code) DO NOTHING;

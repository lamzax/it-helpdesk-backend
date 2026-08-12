-- ============================================================
-- IT Helpdesk + IT Asset Management datubazes shema (PostgreSQL 14+)
-- Dizains: atra izlase pec statusa/kategorijas/lietotaja/ipasnieka,
-- normalizeta struktura, indeksi uz visiem "hot path" laukiem,
-- pilna vestures/audita glabasana (iekartas, aplikacijas, piekluves).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================
-- 1. ORGANIZACIJAS UN LIETOTAJI
-- ============================================================

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    org_type        TEXT NOT NULL CHECK (org_type IN ('internal', 'external')),
    domain          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    email           CITEXT NOT NULL,
    display_name    TEXT NOT NULL,
    department      TEXT,                        -- piem. "Gramatvediba", "IT", "Pardosana"
    job_title       TEXT,
    auth_provider   TEXT NOT NULL CHECK (auth_provider IN ('microsoft', 'google')),
    external_id     TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'requester'
                        CHECK (role IN ('requester', 'agent', 'admin')),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auth_provider, external_id)
);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_org ON users (organization_id);
CREATE INDEX idx_users_department ON users (department);

-- ============================================================
-- 2. TICKET KATEGORIJAS
-- ============================================================

CREATE TABLE categories (
    id              SMALLSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name_lv         TEXT NOT NULL,
    name_en         TEXT NOT NULL,
    default_priority TEXT NOT NULL DEFAULT 'medium'
                        CHECK (default_priority IN ('low','medium','high','critical')),
    sort_order      INTEGER NOT NULL DEFAULT 0,   -- secība, kādā kategorija rādās ticketa formā
    is_active       BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_categories_sort_order ON categories (sort_order);

CREATE TABLE sla_policies (
    id              SERIAL PRIMARY KEY,
    category_id     SMALLINT REFERENCES categories(id),
    priority        TEXT NOT NULL CHECK (priority IN ('low','medium','high','critical')),
    response_minutes INTEGER NOT NULL,
    resolve_minutes  INTEGER NOT NULL,
    UNIQUE (category_id, priority)
);

-- ============================================================
-- 3. IEKARTU (ASSET) PARVALDIBA
-- ============================================================

-- Iekartu tipi: telefoni, datori, monitori, tikla iekartas, perifierija, printeri, cits
CREATE TABLE asset_categories (
    id              SMALLSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,        -- 'phone','computer','monitor','network','peripheral','printer','camera','other'
    name_lv         TEXT NOT NULL,
    name_en         TEXT NOT NULL
);

-- Galvena iekartu tabula -- aptver VISU IT inventaru (ari tikla iekartas un
-- kameras, ko iepriekš skenēja ar QR ticketu izveidei -- tas turpina stradat,
-- jo katrai iekartai joprojam ir qr_code).
CREATE TABLE assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_tag       TEXT NOT NULL,                -- iekšējais inventāra Nr, piem. "IT-000231"
    qr_code         TEXT,                         -- QR uzlīmes kods (skenē ticketu izveidei)
    category_id     SMALLINT NOT NULL REFERENCES asset_categories(id),
    name            TEXT NOT NULL,                -- piem. "Dell Latitude 5440 - J.Berzins"
    manufacturer    TEXT,
    model           TEXT,
    serial_number   TEXT,
    location        TEXT,
    ip_address      INET,
    mac_address     MACADDR,
    -- Iepirkuma un dzives cikla dati
    purchase_date   DATE,
    purchase_price  NUMERIC(10,2),
    vendor          TEXT,
    warranty_until  DATE,
    status          TEXT NOT NULL DEFAULT 'in_stock'
                        CHECK (status IN ('in_stock','in_use','in_repair','retired','disposed')),
    -- Elastīgi papildu lauki atkarībā no tipa (piem. telefonam IMEI, monitoram izmērs)
    -- lai neveidotu desmitiem specifisku tabulu katram iekartas tipam.
    attributes      JSONB NOT NULL DEFAULT '{}',
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_assets_tag ON assets (asset_tag);
CREATE UNIQUE INDEX idx_assets_qr_code ON assets (qr_code) WHERE qr_code IS NOT NULL;
CREATE INDEX idx_assets_category ON assets (category_id);
CREATE INDEX idx_assets_status ON assets (status);
CREATE INDEX idx_assets_serial ON assets (serial_number);
CREATE INDEX idx_assets_attributes ON assets USING GIN (attributes);

-- Kam iekārta piešķirta -- VESTURE (ne tikai pašreizējais stāvoklis).
-- is_current = true atzīmē aktīvo piešķīrumu; vecie ieraksti paliek vēsturei.
CREATE TABLE asset_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at   TIMESTAMPTZ,
    is_current      BOOLEAN NOT NULL DEFAULT true,
    assigned_by     UUID REFERENCES users(id),
    notes           TEXT
);
CREATE INDEX idx_assignments_asset ON asset_assignments (asset_id, assigned_at DESC);
CREATE INDEX idx_assignments_user ON asset_assignments (user_id, assigned_at DESC);
-- Katrai iekārtai jebkurā brīdī drīkst būt tikai VIENS aktīvs (is_current=true) piešķīrums
CREATE UNIQUE INDEX idx_assignments_one_current_per_asset
    ON asset_assignments (asset_id) WHERE is_current = true;

-- Pilna dzives cikla vesture: pirkums -> izsniegsana -> remonts -> parvietosana -> utilizacija
CREATE TABLE asset_lifecycle_events (
    id              BIGSERIAL PRIMARY KEY,
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL
                        CHECK (event_type IN (
                            'purchased','deployed','returned','repair_started','repair_finished',
                            'transferred','status_changed','retired','disposed','note'
                        )),
    description     TEXT,
    performed_by    UUID REFERENCES users(id),
    event_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lifecycle_asset ON asset_lifecycle_events (asset_id, event_at DESC);

-- ============================================================
-- 4. APLIKACIJU (SOFTWARE) PARVALDIBA
-- ============================================================

CREATE TABLE applications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    vendor          TEXT,
    category        TEXT,                         -- piem. 'productivity','security','erp','design'
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_applications_name ON applications (name);

-- Licences katrai aplikacijai (var but vairakas licencu partijas)
CREATE TABLE application_licenses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    license_key     TEXT,
    seats_total     INTEGER NOT NULL DEFAULT 1,
    purchase_date   DATE,
    expires_at      DATE,
    cost            NUMERIC(10,2),
    vendor          TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_licenses_application ON application_licenses (application_id);
CREATE INDEX idx_licenses_expires ON application_licenses (expires_at);

-- Kam aplikacija/licence pieskirta -- VESTURE, lidzigi ka iekartam.
-- Var but pieskirts lietotajam un/vai konkretai iekartai (piem. serveris).
CREATE TABLE application_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    license_id      UUID REFERENCES application_licenses(id),
    user_id         UUID REFERENCES users(id),
    asset_id        UUID REFERENCES assets(id),
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at   TIMESTAMPTZ,
    is_current      BOOLEAN NOT NULL DEFAULT true,
    assigned_by     UUID REFERENCES users(id),
    notes           TEXT,
    CHECK (user_id IS NOT NULL OR asset_id IS NOT NULL)
);
CREATE INDEX idx_app_assignments_app ON application_assignments (application_id, assigned_at DESC);
CREATE INDEX idx_app_assignments_user ON application_assignments (user_id, assigned_at DESC);
CREATE INDEX idx_app_assignments_asset ON application_assignments (asset_id, assigned_at DESC);
CREATE INDEX idx_app_assignments_current ON application_assignments (is_current);

-- ============================================================
-- 5. TALRUNA NUMURI
-- ============================================================

CREATE TABLE phone_numbers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          TEXT NOT NULL,
    carrier         TEXT,                          -- operators
    sim_iccid       TEXT,
    plan_name       TEXT,
    monthly_cost    NUMERIC(10,2),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_phone_numbers_number ON phone_numbers (number);

-- Kam numurs piesaistits -- vesture
CREATE TABLE phone_number_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number_id UUID NOT NULL REFERENCES phone_numbers(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    asset_id        UUID REFERENCES assets(id),     -- kuram telefonam ielikta SIM
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at   TIMESTAMPTZ,
    is_current      BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_phone_assignments_number ON phone_number_assignments (phone_number_id, assigned_at DESC);
CREATE INDEX idx_phone_assignments_user ON phone_number_assignments (user_id, assigned_at DESC);
CREATE UNIQUE INDEX idx_phone_one_current
    ON phone_number_assignments (phone_number_id) WHERE is_current = true;

-- ============================================================
-- 6. PIEKLUVES TIESIBAS (piem. VPN, ERP, failu serveri, sistemas)
-- ============================================================

CREATE TABLE access_systems (
    id              SMALLSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,           -- piem. 'vpn','erp','file_server','crm'
    name            TEXT NOT NULL,
    description     TEXT
);

CREATE TABLE access_rights (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    system_id       SMALLINT NOT NULL REFERENCES access_systems(id),
    access_level    TEXT NOT NULL DEFAULT 'user'
                        CHECK (access_level IN ('read','user','power_user','admin')),
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    is_current      BOOLEAN NOT NULL DEFAULT true,
    granted_by      UUID REFERENCES users(id),
    notes           TEXT
);
CREATE INDEX idx_access_user ON access_rights (user_id, granted_at DESC);
CREATE INDEX idx_access_system ON access_rights (system_id);
CREATE INDEX idx_access_current ON access_rights (is_current);

-- ============================================================
-- 7. TICKETI -- tagad saistiti ar ASSETS (nevis atseviško "devices")
-- ============================================================

CREATE TABLE tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number   TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    category_id     SMALLINT NOT NULL REFERENCES categories(id),
    asset_id        UUID REFERENCES assets(id),      -- ja skenets QR vai izveleta iekarta
    reporter_id     UUID NOT NULL REFERENCES users(id),
    assignee_id     UUID REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','in_progress','waiting','resolved','closed')),
    priority        TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low','medium','high','critical')),
    source          TEXT NOT NULL DEFAULT 'mobile'
                        CHECK (source IN ('mobile','web','qr')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_tickets_number ON tickets (ticket_number);
CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_category ON tickets (category_id);
CREATE INDEX idx_tickets_reporter ON tickets (reporter_id);
CREATE INDEX idx_tickets_assignee ON tickets (assignee_id);
CREATE INDEX idx_tickets_asset ON tickets (asset_id);
CREATE INDEX idx_tickets_created_at ON tickets (created_at DESC);
CREATE INDEX idx_tickets_reporter_created ON tickets (reporter_id, created_at DESC);
CREATE INDEX idx_tickets_status_priority ON tickets (status, priority);
-- Ļauj ātri redzēt "šai iekārtai visi ticketi hronoloģiski" (iekārtas vēsture helpdesk skatā)
CREATE INDEX idx_tickets_asset_created ON tickets (asset_id, created_at DESC);

CREATE TABLE ticket_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    is_internal     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_ticket ON ticket_comments (ticket_id, created_at);

CREATE TABLE ticket_attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    comment_id      UUID REFERENCES ticket_comments(id) ON DELETE CASCADE,
    file_url        TEXT NOT NULL,
    file_name       TEXT,
    mime_type       TEXT,
    uploaded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_ticket ON ticket_attachments (ticket_id);

CREATE TABLE ticket_status_history (
    id              BIGSERIAL PRIMARY KEY,
    ticket_id       UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    old_status      TEXT,
    new_status      TEXT NOT NULL,
    changed_by      UUID REFERENCES users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_status_history_ticket ON ticket_status_history (ticket_id, changed_at);

CREATE TABLE push_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT NOT NULL,
    platform        TEXT NOT NULL CHECK (platform IN ('ios','android')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token)
);

-- ============================================================
-- 8. AUTOMATISKIE TRIGERI
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_assets_updated_at
    BEFORE UPDATE ON assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Kad izveido jaunu asset_assignments ierakstu ar is_current=true,
-- automatiski aizver iepriekšējo aktīvo piešķīrumu tai pašai iekārtai
-- un ieraksta lifecycle notikumu -- lai API kodam nav manuāli jātur šī loģika.
CREATE OR REPLACE FUNCTION close_previous_asset_assignment() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_current THEN
        UPDATE asset_assignments
        SET is_current = false, unassigned_at = now()
        WHERE asset_id = NEW.asset_id AND id != NEW.id AND is_current = true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_close_prev_assignment
    AFTER INSERT ON asset_assignments
    FOR EACH ROW EXECUTE FUNCTION close_previous_asset_assignment();

-- ============================================================
-- 9. SEED DATI
-- ============================================================

INSERT INTO categories (code, name_lv, name_en, default_priority, sort_order) VALUES
    ('lan',          'LAN tikls',              'LAN network',       'high',   1),
    ('wifi',         'WiFi',                   'WiFi',              'medium', 2),
    ('cameras',      'Noverosanas kameras',    'CCTV Cameras',      'medium', 3),
    ('internal_app', 'Ieksejā lietojumprogramma', 'Internal application', 'medium', 4),
    ('other',        'Cits IT jautajums',      'Other IT issue',    'low',    5);

INSERT INTO sla_policies (category_id, priority, response_minutes, resolve_minutes)
SELECT id, 'critical', 15, 240 FROM categories
UNION ALL
SELECT id, 'high', 30, 480 FROM categories
UNION ALL
SELECT id, 'medium', 120, 1440 FROM categories
UNION ALL
SELECT id, 'low', 480, 4320 FROM categories;

INSERT INTO asset_categories (code, name_lv, name_en) VALUES
    ('phone',      'Telefons',         'Phone'),
    ('computer',   'Dators',           'Computer'),
    ('monitor',    'Monitors',         'Monitor'),
    ('network',    'Tikla iekarta',    'Network equipment'),
    ('peripheral', 'Perifierija',      'Peripheral'),
    ('printer',    'Printeris',        'Printer'),
    ('camera',     'Kamera',           'Camera'),
    ('other',      'Cita iekarta',     'Other equipment');

INSERT INTO access_systems (code, name, description) VALUES
    ('vpn',         'VPN piekluve',        'Attaluma piekluve uznemuma tiklam'),
    ('erp',         'ERP sistema',         'Gramatvediba/resursu planosanas sistema'),
    ('file_server', 'Failu serveris',      'Kopejie tikla diski'),
    ('crm',         'CRM sistema',         'Klientu attiecibu parvaldiba'),
    ('email',       'E-pasts (MS365)',     'Microsoft 365 pastkaste'),
    ('wifi_main',    'WiFi (galvenais)',        'Uznemuma galvenais WiFi tikls darbiniekiem'),
    ('wifi_guest',   'WiFi (viesu)',             'Viesu WiFi tikls'),
    ('wifi_iot',     'WiFi (IoT ierices)',       'Atsevisks WiFi tikls IoT/viedajam ierices'),
    ('vpn_computer', 'VPN (dators)',             'VPN piekluve no darba/personigā datora'),
    ('vpn_phone',    'VPN (telefons)',           'VPN piekluve no mobila telefona');

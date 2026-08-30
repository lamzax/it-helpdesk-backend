-- ============================================================
-- IT Helpdesk sistēma v2 — universāls, pašadministrējams pamats.
-- Owner pats no nulles veido admin paneļa struktūru (Moduļi = kategorijas =
-- tabulas, ar bezgalīgu ligzdošanu, pielāgotiem laukiem, vēsturi, CSV
-- importu/eksportu un meklēšanu).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================
-- 1. ORGANIZĀCIJAS UN LIETOTĀJI
-- ============================================================

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    org_type        TEXT NOT NULL CHECK (org_type IN ('internal', 'external')),
    domain          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lietotāji. Tiesību veidi: owner (viss), admin (var pārvaldīt lietotājus un
-- struktūru, bet ne citus adminus/owneri), user (parasts darbinieks/pieteicējs).
-- PIETEIKŠANĀS SISTĒMĀ STRĀDĀ TIKAI JAU REĢISTRĒTIEM LIETOTĀJIEM -- ja e-pasts
-- vai telefona numurs sistēmā nav atrasts, pieteikšanās NEIZDODAS un tiek
-- izveidots pieprasījums "access_requests" tabulā (skat. zemāk).
-- Lietotāji. Tiesību veidi: owner (viss), admin (var pārvaldīt lietotājus un
-- struktūru, bet ne citus adminus/owneri), user (parasts darbinieks/pieteicējs).
-- PIETEIKŠANĀS SISTĒMĀ STRĀDĀ TIKAI JAU REĢISTRĒTIEM LIETOTĀJIEM -- ja e-pasts
-- vai telefona numurs sistēmā nav atrasts, pieteikšanās NEIZDODAS un tiek
-- izveidots pieprasījums "access_requests" tabulā (skat. zemāk).
--
-- BĀZES lauki (email/phone/display_name/role/is_blocked/utt.) ir FIKSĒTI --
-- tie ir nepieciešami autentifikācijai un relācijām, un Owner tos NEVAR
-- mainīt. Jebkurus PAPILDU laukus (piem. "Nodaļa", "Amats", "Biroja Nr.")
-- Owner/Admin pievieno TIEŠI TĀPAT kā jebkuram citam modulim -- ar
-- module_fields, kas norāda uz rezervēto sistēmas moduli "Lietotāji" (skat.
-- modules.system_key zemāk). Vērtības glabājas "data" JSONB laukā.
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    email           CITEXT UNIQUE,
    phone           TEXT UNIQUE,
    display_name    TEXT NOT NULL,
    auth_provider   TEXT CHECK (auth_provider IN ('microsoft', 'google')),
    external_id     TEXT,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
    is_blocked      BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    data            JSONB NOT NULL DEFAULT '{}',
    last_login_at   TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX idx_users_org ON users (organization_id);
CREATE INDEX idx_users_role ON users (role);

-- Pieprasījumi, kad kāds mēģina pieteikties ar e-pastu/telefonu, kas sistēmā
-- NAV reģistrēts -- Owner/Admin redz šo sarakstu admin panelī un var
-- bloķēt/atbloķēt (t.i. izveidot kontu) piekļuvi.
CREATE TABLE access_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier      TEXT NOT NULL,          -- e-pasts vai telefona numurs, ko ievadīja
    display_name    TEXT,
    attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    is_resolved     BOOLEAN NOT NULL DEFAULT false,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    notified_email  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_access_requests_identifier ON access_requests (identifier);
CREATE INDEX idx_access_requests_unresolved ON access_requests (is_resolved);

-- ============================================================
-- 2. MODUĻI -- UNIVERSĀLS, PAŠADMINISTRĒJAMS TABULU DZINĒJS
-- ============================================================
-- Owner veido "moduļus" (piem. "Iekārtas", "Tīkls", "Telefona numuri",
-- "Programmas", "Aprīkojums") -- katrs modulis admin panelī kļūst par savu
-- cilni/tabulu. Moduļi var ligzdoties BEZGALĪGI dziļi (parent_id) -- katra
-- apakškategorija ir arī pati sava pilnībā administrējama tabula.

CREATE TABLE modules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       UUID REFERENCES modules(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    icon            TEXT,                    -- neobligāta emocijzīme/ikona cilnei
    system_key      TEXT UNIQUE,             -- 'users' priekš rezervēta Lietotāju lauku moduļa; NULL parastiem moduļiem
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_modules_parent ON modules (parent_id, sort_order);

-- Katram modulim Owner pievieno SAVUS laukus (kā jau strādājošā "Pielāgoto
-- lauku" sadaļa, bet tagad tas ir VIENĪGAIS veids, kā tabulai ir kolonnas --
-- nav vairs iebūvētu fiksētu lauku, izņemot pašus pamatus "name"/vēsturi/utt,
-- kas nepieciešami relācijām un NAV maināmi).
CREATE TABLE module_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    field_key       TEXT NOT NULL,
    label           TEXT NOT NULL,
    field_type      TEXT NOT NULL CHECK (field_type IN ('text','number','boolean','date','select')),
    options         JSONB NOT NULL DEFAULT '[]',
    is_required     BOOLEAN NOT NULL DEFAULT false,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (module_id, field_key)
);
CREATE INDEX idx_module_fields_module ON module_fields (module_id, sort_order);

-- Faktiskie ieraksti (rindas) katrā modulī. "name" ir vienīgais fiksētais
-- pamatlauks (lai relācijas/attēlojums vienmēr strādā); viss pārējais ir
-- Owner definētajos "module_fields" un glabājas elastīgajā "data" JSONB laukā.
CREATE TABLE records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_records_module ON records (module_id, is_active);
CREATE INDEX idx_records_name ON records USING GIN (to_tsvector('simple', name));
CREATE INDEX idx_records_data ON records USING GIN (data);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_records_updated_at BEFORE UPDATE ON records
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vispārīga vēsture -- KATRAM ierakstam VAI lietotājam: kas/kad/ko darīja.
-- Redzama, uzklikšķinot uz rindas, un eksportējama uz CSV. "entity_type"
-- atšķir, vai vēsture pieder "record" (jebkura moduļa ierakstam) vai "user"
-- (lietotāju administrācijai) -- abiem der TĀ PATI mehānika.
CREATE TABLE record_history (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL DEFAULT 'record' CHECK (entity_type IN ('record', 'user')),
    entity_id       UUID NOT NULL,
    action          TEXT NOT NULL,           -- 'created','field_changed','deleted'
    field_name      TEXT,
    old_value       TEXT,
    new_value       TEXT,
    changed_by      UUID REFERENCES users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes           TEXT
);
CREATE INDEX idx_record_history_lookup ON record_history (entity_type, entity_id, changed_at DESC);

-- ============================================================
-- 3. TICKETI
-- ============================================================
-- Tickets tagad saistās TIEŠI ar izvēlēto moduli (kategoriju/apakškategoriju
-- ceļa GALA punktu) un, ja vajadzīgs, konkrētu ierakstu tajā modulī (piem.
-- konkrētu iekārtu no "Iekārtas" moduļa saraksta).

CREATE TABLE tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number   TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    module_id       UUID REFERENCES modules(id) ON DELETE SET NULL,
    record_id       UUID REFERENCES records(id) ON DELETE SET NULL,
    reporter_id     UUID NOT NULL REFERENCES users(id),
    assignee_id     UUID REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','in_progress','waiting','resolved','closed')),
    priority        TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low','medium','high','critical')),
    source          TEXT NOT NULL DEFAULT 'mobile' CHECK (source IN ('mobile','web','qr')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_tickets_number ON tickets (ticket_number);
CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_module ON tickets (module_id);
CREATE INDEX idx_tickets_reporter_created ON tickets (reporter_id, created_at DESC);
CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

-- ============================================================
-- 4. SĀKOTNĒJAIS OWNER LIETOTĀJS UN SISTĒMAS MODULIS
-- ============================================================
INSERT INTO organizations (name, org_type, domain)
VALUES ('Otan Kimill', 'internal', 'otankimill.eu');

INSERT INTO users (organization_id, email, phone, display_name, auth_provider, external_id, role)
SELECT id, 'guntis.liepins@otankimill.eu', '+37128232835', 'Guntis Liepiņš', 'microsoft', 'owner-seed', 'owner'
FROM organizations WHERE domain = 'otankimill.eu';

-- Rezervēts sistēmas modulis "Lietotāji" -- Owner/Admin šeit pievieno
-- papildu kolonnas darbinieku profiliem (Nodaļa, Amats, u.c.), tāpat kā
-- jebkuram citam modulim (skat. module_fields).
INSERT INTO modules (name, system_key, icon)
VALUES ('Lietotāji', 'users', '👤');

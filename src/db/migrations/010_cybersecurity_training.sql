-- ============================================================
-- MIGRĀCIJA 010 — palaist TIKAI, ja datubāze jau iepriekš izveidota.
-- Pievieno "Kiberdrošība" sadaļu: instrukcijas, testi (ar rezultātu
-- atskaitēm) un pikšķerēšanas simulācijas rīku ar statistiku.
-- ============================================================

CREATE TABLE IF NOT EXISTS training_articles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_tests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_test_questions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id         UUID NOT NULL REFERENCES training_tests(id) ON DELETE CASCADE,
    question        TEXT NOT NULL,
    options         JSONB NOT NULL,
    correct_index   INTEGER NOT NULL,
    explanation     TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_training_questions_test ON training_test_questions (test_id, sort_order);

CREATE TABLE IF NOT EXISTS training_test_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id         UUID NOT NULL REFERENCES training_tests(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    score           INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    answers         JSONB NOT NULL,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_training_attempts_test ON training_test_attempts (test_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_attempts_user ON training_test_attempts (user_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS phishing_campaigns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    sender_name     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent')),
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS phishing_campaign_targets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id     UUID NOT NULL REFERENCES phishing_campaigns(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    token           TEXT NOT NULL UNIQUE,
    sent_at         TIMESTAMPTZ,
    opened_at       TIMESTAMPTZ,
    clicked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_phishing_targets_campaign ON phishing_campaign_targets (campaign_id);
CREATE INDEX IF NOT EXISTS idx_phishing_targets_token ON phishing_campaign_targets (token);

-- ---------- Sākotnējais saturs (jūs to varat brīvi rediģēt/paplašināt) ----------
INSERT INTO training_articles (title, content, sort_order) VALUES
('Kā atpazīt pikšķerēšanas (phishing) e-pastu',
'## Biežākās pazīmes

1. **Steidzinājums un draudi** — "Jūsu konts tiks bloķēts 24 stundu laikā", "Nekavējoties apstipriniet maksājumu". Krāpnieki grib, lai jūs rīkojaties, nepadomājot.
2. **Neatbilstoša sūtītāja adrese** — pārbaudiet, vai domēns tiešām atbilst uzņēmumam (piem. "microsoft-support.ru" nav Microsoft).
3. **Vispārīgs uzrunājums** — "Dear Customer" nevis jūsu vārds.
4. **Aizdomīgas saites** — pirms klikšķināšanas novietojiet peli virs saites (bez klikšķināšanas!) un pārbaudiet, uz kurieni tā tiešām ved.
5. **Pielikumi, ko negaidījāt** — īpaši .exe, .zip, vai makro saturoši Office faili.
6. **Lūgums ievadīt paroli/datus ārpus parastās sistēmas** — bankas, IT vai vadības vārdā nekad nesūta saites uz paroles ievadi e-pastā.
7. **Gramatikas un valodas kļūdas**, neierasts formulējums.

## Ko darīt, ja saņemat aizdomīgu e-pastu

1. **NEKLIKŠĶINIET** uz saitēm un neatveriet pielikumus.
2. **NEATBILDIET** un nesniedziet nekādu informāciju.
3. Pārbaudiet sūtītāja adresi rūpīgi.
4. Ja neesat pārliecināts, sazinieties ar IT nodaļu pa citu kanālu (nevis atbildot uz šo e-pastu).
5. Ziņojiet par to IT administratoram — arī tad, ja jau esat noklikšķinājuši. Ātra rīcība ierobežo kaitējumu.
6. Neizjūtiet kaunu — pikšķerēšana ir veidota, lai maldinātu ikvienu, arī pieredzējušus lietotājus.

## Ja jau esat ievadījis datus vai atvēris pielikumu

1. Nekavējoties mainiet attiecīgā konta paroli (no cita, droša datora/ierīces).
2. Ieslēdziet divu faktoru autentifikāciju, ja tas vēl nav izdarīts.
3. Informējiet IT nodaļu nekavējoties.
4. Sekojiet līdzi neparastai aktivitātei kontā nākamajās dienās.', 1),

('Sociālā inženierija — kad krāpnieks izliekas par kolēģi vai priekšnieku',
'## Kas tas ir

Sociālā inženierija ir mēģinājums manipulēt ar jums, izmantojot uzticēšanos, autoritāti vai steigu — nevis tehniskas metodes. Piemēri: zvans, kas izliekas par IT atbalstu; e-pasts, kas izliekas no vadītāja ("CEO fraud"); WhatsApp ziņa no "kolēģa" ar steidzamu naudas pārskaitījuma lūgumu.

## Brīdinājuma pazīmes

- Neparasts kanāls (piem., vadītājs, kurš parasti raksta e-pastā, pēkšņi raksta WhatsApp no nezināma numura).
- Lūgums neko nevienam nestāstīt vai rīkoties "diskrēti".
- Steidzams finansiāls pieprasījums vai lūgums nopirkt dāvanu kartes.
- Lūgums nosaukt paroli, kodu vai apstiprināt divu faktoru pieprasījumu pa telefonu.

## Kā rīkoties

1. Vienmēr pārbaudiet identitāti pa OTRU, jau zināmu kanālu (piem., piezvaniet uz zināmo darba numuru, nevis to, no kura tikko saņēmāt ziņu).
2. IT nodaļa NEKAD nelūgs jūsu paroli.
3. Finanšu pieprasījumus vienmēr apstipriniet klātienē vai pa tālruni ar zināmu numuru.
4. Ja kaut kas šķiet dīvaini — tas, visticamāk, arī ir. Uzticieties savai intuīcijai un jautājiet IT.', 2);

INSERT INTO training_tests (id, title, description)
VALUES (gen_random_uuid(), 'Pikšķerēšanas atpazīšanas pamati', 'Īss tests, lai pārbaudītu, cik labi protat atpazīt pikšķerēšanas mēģinājumus.');

INSERT INTO training_test_questions (test_id, question, options, correct_index, explanation, sort_order)
SELECT id, q.question, q.options::jsonb, q.correct_index, q.explanation, q.ord
FROM training_tests,
(VALUES
  ('E-pastā rakstīts: "Jūsu konts tiks bloķēts 24h laikā, ja neapstiprināsiet datus šeit". Ko tas norāda?',
   '["Tas ir normāls drošības brīdinājums","Tas ir tipisks steidzinājuma triks, biežs pikšķerēšanā","Vienmēr jāklikšķina uzreiz, lai izvairītos no bloķēšanas","Tas nozīmē, ka e-pasts ir droši ignorējams bez pārbaudes"]',
   1, 'Mākslīgs steidzinājums ir viena no visbiežākajām pikšķerēšanas pazīmēm — tas liek rīkoties, nepadomājot.', 1),
  ('Kā vislabāk pārbaudīt, uz kurieni tiešām ved saite e-pastā?',
   '["Uzklikšķināt un paskatīties","Novietot peli virs saites bez klikšķināšanas un apskatīt adresi","Pārsūtīt saiti draugam","Ignorēt, jo pārbaudīt nav iespējams"]',
   1, 'Peles novietošana virs saites (bez klikšķa) parasti parāda reālo mērķa adresi ekrāna apakšā.', 2),
  ('Kolēģis WhatsApp no jums nezināma numura steidzami lūdz iegādāties dāvanu kartes uzņēmuma vārdā. Ko darīt?',
   '["Uzreiz iegādāties, jo kolēģis lūdz","Ignorēt pilnībā, neko nedarot","Piezvanīt kolēģim uz jau zināmo darba numuru, lai pārbaudītu","Atbildēt WhatsApp, prasot vairāk detaļu"]',
   2, 'Identitāte vienmēr jāpārbauda pa jau zināmu, uzticamu kanālu, nevis to pašu, no kura nāk aizdomīgais pieprasījums.', 3),
  ('IT administrators piezvana un lūdz pateikt jūsu paroli, lai "salabotu problēmu". Ko darīt?',
   '["Pateikt paroli, jo tas ir IT","Nekad nedot paroli — īsta IT nodaļa to nekad nelūdz","Pateikt tikai daļu paroles","Nomainīt paroli uz vienkāršāku, lai IT varētu palīdzēt"]',
   1, 'Neviena leģitīma IT nodaļa nekad nelūgs jūsu paroli — tā ir klasiska sociālās inženierijas taktika.', 4),
  ('Kuru no šiem NEVAJADZĒTU uzskatīt par uzticamu sūtītāja pazīmi?',
   '["Precīzs uzņēmuma domēns e-pasta adresē","Personalizēts uzrunājums ar jūsu vārdu","Uzņēmuma logo e-pasta dizainā (to var viegli nokopēt)","Zināms, iepriekš izmantots kontakts"]',
   2, 'Logo un dizainu krāpnieki var viegli nokopēt — tas pats par sevi neko nepierāda par sūtītāja īstumu.', 5),
  ('Jūs jau esat ievadījis paroli aizdomīgā vietnē. Kas jādara VISPIRMS?',
   '["Nekas, jo kaitējums jau nodarīts","Nekavējoties nomainīt attiecīgā konta paroli no cita, droša datora","Gaidīt un vērot, vai kaut kas notiek","Dzēst e-pastu un aizmirst par to"]',
   1, 'Ātra paroles maiņa ierobežo iespējamo kaitējumu — jo ātrāk, jo labāk.', 6)
) AS q(question, options, correct_index, explanation, ord)
WHERE training_tests.title = 'Pikšķerēšanas atpazīšanas pamati';

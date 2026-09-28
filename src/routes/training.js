// ============================================================
// KIBERDROŠĪBA — apmācības: instrukcijas (raksti) un testi.
//
// Instrukcijas un testu izpilde pieejama VISIEM reģistrētajiem lietotājiem.
// Testu veidošana/rediģēšana un atskaites — tikai Owner/Admin.
// Katram async maršrutam ir try/catch (skat. HANDOFF 6.2), lai kļūda
// neizraisītu 502 un "pakārušos" pieprasījumu.
// ============================================================

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const csvEscape = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// ============================================================
// INSTRUKCIJAS (training_articles)
// ============================================================

// GET /api/training/articles — visi raksti (visiem lietotājiem)
router.get('/articles', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, content, sort_order, updated_at FROM training_articles ORDER BY sort_order, title'
    );
    res.json({ articles: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/articles — jauns raksts (owner/admin)
router.post('/articles', requireRole('owner', 'admin'), async (req, res) => {
  const { title, content, sortOrder } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Nepieciešams virsraksts un saturs' });
  try {
    const result = await pool.query(
      `INSERT INTO training_articles (title, content, sort_order, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [title, content, Number(sortOrder) || 0, req.user.id]
    );
    res.status(201).json({ article: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/training/articles/:id (owner/admin)
router.patch('/articles/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { title, content, sortOrder } = req.body;
  try {
    const result = await pool.query(
      `UPDATE training_articles
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           sort_order = COALESCE($3, sort_order),
           updated_at = now()
       WHERE id = $4 RETURNING *`,
      [title ?? null, content ?? null, sortOrder ?? null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Raksts nav atrasts' });
    res.json({ article: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/training/articles/:id (owner/admin)
router.delete('/articles/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM training_articles WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Raksts nav atrasts' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TESTI (training_tests + training_test_questions + attempts)
// ============================================================

// GET /api/training/tests — aktīvie testi, ko lietotājs var pildīt (visiem)
router.get('/tests', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.title, t.description,
              (SELECT COUNT(*) FROM training_test_questions q WHERE q.test_id = t.id) AS question_count
       FROM training_tests t
       WHERE t.is_active = true
       ORDER BY t.created_at`
    );
    res.json({ tests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/tests/all — visi testi arī neaktīvie (owner/admin)
router.get('/tests/all', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.title, t.description, t.is_active, t.created_at,
              (SELECT COUNT(*) FROM training_test_questions q WHERE q.test_id = t.id) AS question_count,
              (SELECT COUNT(*) FROM training_test_attempts a WHERE a.test_id = t.id) AS attempt_count
       FROM training_tests t
       ORDER BY t.created_at`
    );
    res.json({ tests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/tests/:id/take — jautājumi BEZ pareizajām atbildēm (visiem)
router.get('/tests/:id/take', async (req, res) => {
  try {
    const testRes = await pool.query('SELECT id, title, description FROM training_tests WHERE id = $1 AND is_active = true', [req.params.id]);
    if (testRes.rows.length === 0) return res.status(404).json({ error: 'Tests nav atrasts vai nav aktīvs' });
    const qRes = await pool.query(
      'SELECT id, question, options, sort_order FROM training_test_questions WHERE test_id = $1 ORDER BY sort_order',
      [req.params.id]
    );
    res.json({ test: testRes.rows[0], questions: qRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/tests/:id/attempt — iesniedz atbildes, atgriež rezultātu
// Body: { answers: { <questionId>: <selectedIndex>, ... } }
router.post('/tests/:id/attempt', async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Trūkst atbilžu' });
  try {
    const qRes = await pool.query(
      'SELECT id, question, options, correct_index, explanation, sort_order FROM training_test_questions WHERE test_id = $1 ORDER BY sort_order',
      [req.params.id]
    );
    if (qRes.rows.length === 0) return res.status(404).json({ error: 'Testam nav jautājumu' });

    let score = 0;
    const review = qRes.rows.map((q) => {
      const selected = answers[q.id];
      const isCorrect = Number(selected) === q.correct_index;
      if (isCorrect) score++;
      return {
        id: q.id,
        question: q.question,
        options: q.options,
        selectedIndex: selected === undefined ? null : Number(selected),
        correctIndex: q.correct_index,
        isCorrect,
        explanation: q.explanation,
      };
    });

    await pool.query(
      `INSERT INTO training_test_attempts (test_id, user_id, score, total_questions, answers)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, req.user.id, score, qRes.rows.length, JSON.stringify(answers)]
    );

    res.json({ score, total: qRes.rows.length, review });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/my-attempts — lietotāja paša mēģinājumi (visiem)
router.get('/my-attempts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.test_id, t.title AS test_title, a.score, a.total_questions, a.completed_at
       FROM training_test_attempts a
       JOIN training_tests t ON t.id = a.test_id
       WHERE a.user_id = $1
       ORDER BY a.completed_at DESC`,
      [req.user.id]
    );
    res.json({ attempts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/tests — jauns tests ar jautājumiem (owner/admin)
// Body: { title, description, questions: [{ question, options:[...], correctIndex, explanation }] }
router.post('/tests', requireRole('owner', 'admin'), async (req, res) => {
  const { title, description, questions } = req.body;
  if (!title) return res.status(400).json({ error: 'Nepieciešams testa nosaukums' });
  if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Nepieciešams vismaz viens jautājums' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const testRes = await client.query(
      'INSERT INTO training_tests (title, description, created_by) VALUES ($1,$2,$3) RETURNING *',
      [title, description || null, req.user.id]
    );
    const test = testRes.rows[0];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question || !Array.isArray(q.options) || q.options.length < 2) {
        throw new Error(`Jautājums #${i + 1}: nepieciešams teksts un vismaz 2 atbilžu varianti`);
      }
      const correctIndex = Number(q.correctIndex);
      if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= q.options.length) {
        throw new Error(`Jautājums #${i + 1}: nederīgs pareizās atbildes numurs`);
      }
      await client.query(
        `INSERT INTO training_test_questions (test_id, question, options, correct_index, explanation, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [test.id, q.question, JSON.stringify(q.options), correctIndex, q.explanation || null, i + 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ test });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/training/tests/:id — nosaukums/apraksts/aktivitāte + neobligāti jautājumu pārrakstīšana (owner/admin)
router.patch('/tests/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { title, description, isActive, questions } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE training_tests
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           is_active = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [title ?? null, description ?? null, typeof isActive === 'boolean' ? isActive : null, req.params.id]
    );
    if (upd.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tests nav atrasts' }); }

    // Ja padoti jautājumi — aizvieto visus esošos ar jaunajiem
    if (Array.isArray(questions)) {
      await client.query('DELETE FROM training_test_questions WHERE test_id = $1', [req.params.id]);
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.question || !Array.isArray(q.options) || q.options.length < 2) {
          throw new Error(`Jautājums #${i + 1}: nepieciešams teksts un vismaz 2 atbilžu varianti`);
        }
        const correctIndex = Number(q.correctIndex);
        if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= q.options.length) {
          throw new Error(`Jautājums #${i + 1}: nederīgs pareizās atbildes numurs`);
        }
        await client.query(
          `INSERT INTO training_test_questions (test_id, question, options, correct_index, explanation, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, q.question, JSON.stringify(q.options), correctIndex, q.explanation || null, i + 1]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ test: upd.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/training/tests/:id (owner/admin)
router.delete('/tests/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM training_tests WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tests nav atrasts' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/tests/:id/report — per-lietotāja rezultāti (owner/admin)
router.get('/tests/:id/report', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const testRes = await pool.query('SELECT id, title FROM training_tests WHERE id = $1', [req.params.id]);
    if (testRes.rows.length === 0) return res.status(404).json({ error: 'Tests nav atrasts' });
    // Katra lietotāja pēdējais (jaunākais) mēģinājums
    const rows = await pool.query(
      `SELECT DISTINCT ON (a.user_id)
              u.display_name, u.email, u.phone,
              a.score, a.total_questions, a.completed_at
       FROM training_test_attempts a
       JOIN users u ON u.id = a.user_id
       WHERE a.test_id = $1
       ORDER BY a.user_id, a.completed_at DESC`,
      [req.params.id]
    );
    res.json({ test: testRes.rows[0], results: rows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/tests/:id/report/export — CSV (owner/admin)
router.get('/tests/:id/report/export', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT DISTINCT ON (a.user_id)
              u.display_name, u.email, u.phone,
              a.score, a.total_questions, a.completed_at
       FROM training_test_attempts a
       JOIN users u ON u.id = a.user_id
       WHERE a.test_id = $1
       ORDER BY a.user_id, a.completed_at DESC`,
      [req.params.id]
    );
    const columns = ['Vārds', 'E-pasts', 'Telefons', 'Rezultāts', 'Kopā jautājumi', 'Procenti', 'Pabeigts'];
    const data = rows.rows.map((r) => [
      r.display_name, r.email, r.phone, r.score, r.total_questions,
      r.total_questions ? Math.round((r.score / r.total_questions) * 100) + '%' : '',
      r.completed_at ? new Date(r.completed_at).toLocaleString('lv-LV') : '',
    ]);
    const csv = [columns.map(csvEscape).join(','), ...data.map((r) => r.map(csvEscape).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="testa_rezultati.csv"');
    res.send('﻿' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

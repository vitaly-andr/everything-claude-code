#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Reset GateGuard checked-state on new tasks.
 *
 * On each new user prompt, wipes the gate's `checked` list so the
 * Fact-Forcing gate fires again on the first edit per file. Continuation
 * phrases (короткие подтверждения вроде «да»/«продолжай»/yes/ok)
 * preserve state — agent keeps working within the already-approved
 * context without re-presenting facts for files it just edited.
 *
 * Cross-platform (Linux/macOS/Windows).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_DIR =
  process.env.GATEGUARD_STATE_DIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.gateguard');

const CONTINUATION_PATTERNS = [
  /^(да|нет|ок|ok|yes|no|sure)\.?$/i,
  /^(продолжай|continue|go|применяй|apply|публикуй|publish)\.?$/i,
  /^(скип|skip|stop|стоп|отмена|abort)\.?$/i,
  /^[+\-✓✗]+$/,
];

function isContinuation(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return false;
  return CONTINUATION_PATTERNS.some(re => re.test(trimmed));
}

// Session key resolution — must mirror gateguard-fact-force.js so the
// state files line up. Keep in sync if upstream changes session keying.
function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) return sanitized;
  return hashSessionKey('sid', raw);
}

function hashSessionKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function resolveSessionKey(data) {
  const direct = [
    data && data.session_id,
    data && data.sessionId,
    data && data.session && data.session.id,
    process.env.CLAUDE_SESSION_ID,
    process.env.ECC_SESSION_ID,
  ];
  for (const c of direct) {
    const s = sanitizeSessionKey(c);
    if (s) return s;
  }
  const tx =
    (data && (data.transcript_path || data.transcriptPath)) ||
    process.env.CLAUDE_TRANSCRIPT_PATH;
  if (tx && String(tx).trim()) {
    return hashSessionKey('tx', path.resolve(String(tx).trim()));
  }
  const projectFingerprint = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return hashSessionKey('proj', path.resolve(projectFingerprint));
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdinSync();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    /* ignore parse errors — treat as empty */
  }

  const prompt = data.prompt || data.user_prompt || '';

  if (isContinuation(prompt)) {
    process.stderr.write('[UserPromptReset] continuation phrase; gate state preserved\n');
    return;
  }

  const sessionKey = resolveSessionKey(data);
  const stateFile = path.join(STATE_DIR, `state-${sessionKey}.json`);

  let priorCount = 0;
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      priorCount = Array.isArray(state.checked) ? state.checked.length : 0;
    }
  } catch {
    /* ignore — we'll overwrite */
  }

  const newState = { checked: [], last_active: Date.now() };
  let tmpFile = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    tmpFile = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpFile, JSON.stringify(newState, null, 2), 'utf8');
    fs.renameSync(tmpFile, stateFile);
    tmpFile = null;
    process.stderr.write(`[UserPromptReset] new prompt; cleared ${priorCount} gate entries\n`);
  } catch (e) {
    process.stderr.write(`[UserPromptReset] failed to reset: ${e.message}\n`);
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
  }
}

main();

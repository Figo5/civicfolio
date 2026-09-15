// Environment-file hygiene, enforced by Git's own ignore/index machinery
// rather than by reading .gitignore and hoping the patterns mean what we think.
//
// The gap this pins: .gitignore listed .env variants individually, so a local
// backup (.env.save) was NOT ignored and was one `git add -A` away from being
// committed. No credential was ever exposed — that file's OPENAI_API_KEY was
// empty and it was never committed — but the rules now deny by default.
//
// No secret value is ever read or printed here: the tests ask Git about paths,
// and where a file must be checked for sanitization, only value LENGTHS are
// compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const repo = path.resolve(url.fileURLToPath(new URL('../../', import.meta.url)));

function git(args: string[]): { status: number; out: string } {
  try {
    // stdio 'pipe' for stderr: a deliberate "not tracked" probe makes Git write
    // to stderr, and that is an expected answer here, not test output.
    return { status: 0, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, out: err.stdout ?? '' };
  }
}

/** Does Git ignore this path? Asked of Git, not inferred from the file. */
const isIgnored = (p: string): boolean => git(['check-ignore', '-q', '--', p]).status === 0;

/** Is this path in the index? */
const isTracked = (p: string): boolean =>
  git(['ls-files', '--error-unmatch', '--', p]).status === 0;

// Local secret files and every backup suffix a shell, editor or human invents.
const MUST_BE_IGNORED = [
  '.env',
  '.env.save',
  '.env.bak',
  '.env.backup',
  '.env.old',
  '.env.local',
  '.env.production',
  '.env.production.local',
  'server/.env',
  '.env.example.bak',
  '.env.example~',
];

// Sanitized templates that must stay in the repo.
const MUST_BE_TRACKABLE = ['.env.example'];

test('every local env file and backup variant is ignored', () => {
  for (const p of MUST_BE_IGNORED) {
    assert.ok(isIgnored(p), `${p} must be git-ignored — a secret backup must never be committable`);
  }
});

test('the sanitized template is NOT ignored and stays tracked', () => {
  for (const p of MUST_BE_TRACKABLE) {
    assert.ok(!isIgnored(p), `${p} is a sanitized template and must remain in the repo`);
    assert.ok(isTracked(p), `${p} must be tracked`);
  }
});

test('no local env file is tracked in the index', () => {
  for (const p of ['.env', '.env.save', '.env.local']) {
    assert.ok(!isTracked(p), `${p} must not be tracked`);
  }
});

test('no env file other than sanitized templates has ever been added to history', () => {
  const { out } = git(['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A']);
  const added = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  const allowed = new Set(['.env.example', '.env.sample', '.env.template']);
  const leaked = [...added].filter((f) => /(^|\/)\.env($|\.)/.test(f) && !allowed.has(f));
  assert.deepEqual(leaked, [],
    `these env files were added to Git history at some point: ${leaked.join(', ')} — rotate the affected credentials`);
});

test('the tracked template carries no secret values', () => {
  // Only lengths and non-secret names are inspected; no value is printed.
  const text = fs.readFileSync(path.join(repo, '.env.example'), 'utf8');
  const SECRETS = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, name, value] = m;
    if (SECRETS.test(name)) {
      assert.equal(value.trim().length, 0,
        `${name} in .env.example must be empty — a template must never carry a real credential`);
    }
  }
});

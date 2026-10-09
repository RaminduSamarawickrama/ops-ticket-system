// Create an administrator or reset a password. There is no public registration.
//
//   npm run admin:create                 (prompts for username and password)
//   npm run admin:reset-password         (prompts for username and new password)
//
// For non-interactive use set ADMIN_USERNAME and ADMIN_PASSWORD in the environment for that one command.
import { createInterface } from 'node:readline';
import { hashPassword, normalizeUsername, validateNewPassword } from '../server/auth.js';
import { createPool } from '../server/db.js';

const mode = process.argv[2];
if (mode !== 'create' && mode !== 'reset-password') {
  console.error('Usage: tsx scripts/admin.ts <create|reset-password>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Hide typed characters for passwords.
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const username = normalizeUsername(process.env.ADMIN_USERNAME ?? (await ask('Username: ')));
if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
  console.error('Username must be 3-64 characters: letters, numbers, dot, dash or underscore.');
  process.exit(1);
}
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await ask('Password (min 12 characters): ', true);
  const confirm = await ask('Confirm password: ', true);
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
}
const problem = validateNewPassword(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const db = createPool(url);
try {
  const hash = await hashPassword(password);
  if (mode === 'create') {
    const res = await db.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING id',
      [username, hash],
    );
    if (res.rowCount === 0) {
      console.error(`An admin named "${username}" already exists. Use npm run admin:reset-password instead.`);
      process.exitCode = 1;
    } else {
      console.log(`Admin "${username}" created.`);
    }
  } else {
    const res = await db.query('UPDATE admins SET password_hash = $2 WHERE username = $1 RETURNING id', [username, hash]);
    if (res.rowCount === 0) {
      console.error(`No admin named "${username}".`);
      process.exitCode = 1;
    } else {
      // Sign the admin out everywhere after a password change.
      await db.query('DELETE FROM sessions WHERE admin_id = $1', [res.rows[0].id]);
      console.log(`Password updated for "${username}". Existing sessions were signed out.`);
    }
  }
} finally {
  await db.end();
}

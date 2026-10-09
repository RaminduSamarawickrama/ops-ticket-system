import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { Mailer } from './email.js';
import type { FileStorage } from './storage.js';

/** Everything the API needs. Tests pass in fakes for storage and email. */
export interface Deps {
  db: Db;
  storage: FileStorage;
  mailer: Mailer;
  config: AppConfig;
}

'use strict';

const session = require('express-session');

/**
 * Small SQLite-backed express-session store.
 *
 * MemoryStore is not suitable for a production process: sessions disappear on
 * restart and cannot be shared by workers.  This store keeps only the opaque
 * session object and an expiry timestamp in SQLite.  It never stores a
 * password or an authentication token.
 */
class SQLiteSessionStore extends session.Store {
  constructor(db, defaultTtlMs) {
    super();
    this.db = db;
    this.defaultTtlMs = Math.max(60_000, Number(defaultTtlMs) || 8 * 60 * 60 * 1000);
    this.getStatement = db.prepare('SELECT sess, expires FROM sessions WHERE sid=?');
    this.upsertStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires
    `);
    this.deleteStatement = db.prepare('DELETE FROM sessions WHERE sid=?');
    this.touchStatement = db.prepare('UPDATE sessions SET sess=?, expires=? WHERE sid=?');
    this.clearStatement = db.prepare('DELETE FROM sessions');
    this.lengthStatement = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires>?');
    this.allStatement = db.prepare('SELECT sess FROM sessions WHERE expires>?');
    this.clearExpiredStatement = db.prepare('DELETE FROM sessions WHERE expires<=?');
  }

  expiryFor(sess) {
    const cookie = sess && sess.cookie ? sess.cookie : {};
    const cookieExpiry = cookie.expires ? new Date(cookie.expires).getTime() : 0;
    if (Number.isFinite(cookieExpiry) && cookieExpiry > 0) return cookieExpiry;
    const maxAge = Number(cookie.maxAge);
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.defaultTtlMs);
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(String(sid));
      if (!row) return callback(null, null);
      if (!Number.isFinite(row.expires) || row.expires <= Date.now()) {
        this.deleteStatement.run(String(sid));
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      this.upsertStatement.run(String(sid), JSON.stringify(sess), this.expiryFor(sess));
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStatement.run(JSON.stringify(sess), this.expiryFor(sess), String(sid));
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.deleteStatement.run(String(sid));
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  clear(callback) {
    try {
      this.clearStatement.run();
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
    }
  }

  length(callback) {
    try {
      callback(null, this.lengthStatement.get(Date.now()).count);
    } catch (error) {
      callback(error);
    }
  }

  all(callback) {
    try {
      callback(null, this.allStatement.all(Date.now()).map(row => JSON.parse(row.sess)));
    } catch (error) {
      callback(error);
    }
  }

  clearExpired() {
    try {
      return this.clearExpiredStatement.run(Date.now()).changes;
    } catch (_) {
      return 0;
    }
  }
}

module.exports = { SQLiteSessionStore };

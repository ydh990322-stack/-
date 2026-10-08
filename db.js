// 데이터베이스 스키마 / 초기 데이터 / 포인트 원장 헬퍼
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

function makeReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// KST(한국시간) 기준 날짜 유틸
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function kstToday() {
  return kstNow().toISOString().slice(0, 10);
}
// 이번 주 월요일 ~ 일요일 (KST, YYYY-MM-DD)
function kstWeekRange(base = kstNow()) {
  const d = new Date(base);
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const sun = new Date(mon.getTime() + 6 * 86400 * 1000);
  return { start: mon.toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10) };
}

function open(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      nickname TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',          -- member | admin
      child_stage TEXT,                              -- 임신중, 0~12개월, 1~3세, 4~7세, 초등
      region TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT NOT NULL UNIQUE,
      referred_by INTEGER REFERENCES users(id),
      last_attendance TEXT,
      attendance_streak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS point_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      kst_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pt_user ON point_transactions(user_id, kst_date, type);

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'weekly',           -- weekly | special
      emoji TEXT NOT NULL DEFAULT '🎉',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      participation_points INTEGER NOT NULL DEFAULT 0,
      prize_points INTEGER NOT NULL DEFAULT 0,
      winners_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open',           -- open | closed
      week_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      is_winner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,                        -- 기프티콘 | 육아용품 | 도서
      emoji TEXT NOT NULL DEFAULT '🎁',
      price INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      needs_address INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      price INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT,
      status TEXT NOT NULL DEFAULT 'requested',      -- requested | sent | canceled
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,                       -- 차감 포인트
      fee INTEGER NOT NULL,
      payout INTEGER NOT NULL,                       -- 실 지급액(원)
      bank TEXT NOT NULL,
      account_number TEXT NOT NULL,
      account_holder TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',        -- pending | paid | rejected
      admin_memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );
  `);
}

// 포인트 적립/차감은 반드시 이 함수를 통해서만 (원장 기록 + 잔액 동기화)
function addPoints(db, userId, amount, type, description) {
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('존재하지 않는 회원입니다.');
  const balance = user.points + amount;
  if (balance < 0) {
    const err = new Error('포인트가 부족합니다.');
    err.status = 400;
    throw err;
  }
  db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, userId);
  db.prepare(
    'INSERT INTO point_transactions (user_id, amount, balance, type, description, kst_date) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, amount, balance, type, description, kstToday());
  return balance;
}

// 하루 적립 횟수 제한이 있는 활동 포인트
function addDailyCappedPoints(db, userId, rule, description) {
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM point_transactions WHERE user_id = ? AND type = ? AND kst_date = ?')
    .get(userId, rule.type, kstToday());
  if (count >= rule.dailyLimit) return 0;
  addPoints(db, userId, rule.points, rule.type, description);
  return rule.points;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const WEEKLY_TEMPLATES = [
  {
    emoji: '💡',
    title: '이번 주 육아 꿀팁 챌린지',
    description:
      '나만 알기 아까운 육아 꿀팁을 공유해 주세요! 수면, 이유식, 놀이, 정리정돈 무엇이든 좋아요. 참여만 해도 포인트, 베스트 꿀팁은 추가 포인트를 드려요.',
  },
  {
    emoji: '📸',
    title: '우리 아이 웃음 자랑 주간',
    description:
      '이번 주 아이가 가장 크게 웃었던 순간을 이야기로 들려주세요. 따뜻한 사연을 골라 당첨 포인트를 드립니다.',
  },
  {
    emoji: '🍚',
    title: '이번 주 이유식·아이밥 레시피',
    description:
      '아이가 잘 먹었던 레시피를 재료와 함께 공유해 주세요. 다른 엄마·아빠들에게 큰 힘이 됩니다!',
  },
  {
    emoji: '💌',
    title: '배우자에게 고마운 한마디',
    description:
      '함께 육아하는 배우자·가족에게 이번 주 고마웠던 점을 남겨주세요. 추첨을 통해 커피 쿠폰 대신 포인트를 드려요.',
  },
  {
    emoji: '🧸',
    title: '이번 주 찐 육아템 추천',
    description: '써보니 정말 좋았던 육아템과 그 이유를 알려주세요. 광고·협찬 글은 제외됩니다.',
  },
];

// 이번 주 정기 이벤트가 없으면 자동 생성
function ensureWeeklyEvent(db) {
  const { start, end } = kstWeekRange();
  const exists = db.prepare('SELECT id FROM events WHERE week_key = ?').get(start);
  if (exists) return exists.id;
  const weekIndex = Math.floor(Date.parse(start) / (7 * 86400 * 1000));
  const t = WEEKLY_TEMPLATES[weekIndex % WEEKLY_TEMPLATES.length];
  const p = config.points;
  const r = db
    .prepare(
      `INSERT INTO events (title, description, kind, emoji, start_date, end_date, participation_points, prize_points, winners_count, week_key)
       VALUES (?, ?, 'weekly', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(t.title, t.description, t.emoji, start, end, p.eventEntry, p.weeklyPrize, p.weeklyWinners, start);
  return Number(r.lastInsertRowid);
}

function seed(db) {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (!admin) {
    db.prepare(
      `INSERT INTO users (email, password, nickname, role, referral_code, points) VALUES (?, ?, ?, 'admin', ?, 0)`
    ).run(config.admin.email, hashPassword(config.admin.password), '운영자', makeReferralCode());
  }

  const { c: productCount } = db.prepare('SELECT COUNT(*) AS c FROM products').get();
  if (productCount === 0) {
    const ins = db.prepare(
      'INSERT INTO products (name, description, category, emoji, price, stock, needs_address) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    [
      ['편의점 모바일 상품권 3천원', '전국 편의점에서 사용 가능한 모바일 상품권', '기프티콘', '🏪', 3000, 100, 0],
      ['카페 아메리카노 기프티콘', '육아 중 잠깐의 휴식, 커피 한 잔', '기프티콘', '☕', 4500, 100, 0],
      ['배달앱 1만원 쿠폰', '오늘 저녁은 배달로! 요리 쉬는 날', '기프티콘', '🛵', 10000, 50, 0],
      ['아기 물티슈 캡형 10팩', '도톰한 엠보싱 원단, 무향 저자극', '육아용품', '🧻', 12000, 30, 1],
      ['신생아 기저귀 1팩', '밤새 보송한 프리미엄 밴드형', '육아용품', '👶', 15000, 30, 1],
      ['아기 손발 보습 로션', '민감한 아기 피부를 위한 저자극 로션', '육아용품', '🧴', 9000, 40, 1],
      ['베스트셀러 그림책 세트(3권)', '잠자리 독서에 좋은 그림책 모음', '도서', '📚', 20000, 20, 1],
    ].forEach((row) => ins.run(...row));
  }

  const { c: eventCount } = db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'special'").get();
  if (eventCount === 0) {
    const { start } = kstWeekRange();
    const end = new Date(Date.parse(start) + 30 * 86400 * 1000).toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO events (title, description, kind, emoji, start_date, end_date, participation_points, prize_points, winners_count)
       VALUES (?, ?, 'special', ?, ?, ?, ?, ?, ?)`
    ).run(
      '그랜드 오픈 기념! 가입 후기 남기기',
      '커뮤니티 오픈을 축하해 주세요! 가입 소감이나 바라는 점을 남겨주시면 참여 포인트를 드리고, 추첨으로 5분께 5,000P를 드립니다. 친구를 초대하면 초대 포인트도 따로 적립돼요.',
      '🎊',
      start,
      end,
      200,
      5000,
      5
    );
  }

  ensureWeeklyEvent(db);
}

module.exports = {
  open,
  tx,
  addPoints,
  addDailyCappedPoints,
  ensureWeeklyEvent,
  hashPassword,
  verifyPassword,
  makeReferralCode,
  kstToday,
  kstWeekRange,
};

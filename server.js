const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const store = require('./db');

const { tx, addPoints, addDailyCappedPoints } = store;

const CATEGORIES = ['공지', '육아정보', '자유수다', '질문답변', '육아템리뷰', '지역모임'];
const CHILD_STAGES = ['임신중', '0~12개월', '1~3세', '4~7세', '초등학생', '기타'];
const BANKS = ['국민', '신한', '우리', '하나', '농협', '기업', '카카오뱅크', '토스뱅크', '케이뱅크', '새마을금고', '우체국', 'SC제일', '부산', '대구'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function text(value, name, min, max) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min) throw httpError(400, `${name}을(를) ${min}자 이상 입력해 주세요.`);
  if (v.length > max) throw httpError(400, `${name}은(는) ${max}자 이하로 입력해 주세요.`);
  return v;
}

function int(value, name, min = 1) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw httpError(400, `${name} 값이 올바르지 않습니다.`);
  return n;
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    role: u.role,
    childStage: u.child_stage,
    region: u.region,
    points: u.points,
    referralCode: u.referral_code,
    lastAttendance: u.last_attendance,
    attendanceStreak: u.attendance_streak,
    createdAt: u.created_at,
  };
}

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ── 인증 ───────────────────────────────────────────────
  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + config.sessionDays * 86400 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
    return token;
  }

  app.use((req, res, next) => {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      req.user = db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = ? AND s.expires_at > ?`
        )
        .get(token, new Date().toISOString());
      req.token = token;
    }
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : next(httpError(401, '로그인이 필요합니다.')));
  const requireAdmin = (req, res, next) =>
    req.user?.role === 'admin' ? next() : next(httpError(403, '관리자만 접근할 수 있습니다.'));

  app.get('/api/config', (req, res) => {
    res.json({
      siteName: config.siteName,
      categories: CATEGORIES,
      childStages: CHILD_STAGES,
      banks: BANKS,
      points: config.points,
      withdrawal: config.withdrawal,
    });
  });

  app.post('/api/auth/signup', (req, res) => {
    const email = text(req.body.email, '이메일', 5, 100).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '이메일 형식이 올바르지 않습니다.');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 8) throw httpError(400, '비밀번호는 8자 이상이어야 합니다.');
    const nickname = text(req.body.nickname, '닉네임', 2, 12);
    const childStage = CHILD_STAGES.includes(req.body.childStage) ? req.body.childStage : null;
    const region = typeof req.body.region === 'string' ? req.body.region.trim().slice(0, 20) || null : null;
    const refCode = typeof req.body.referralCode === 'string' ? req.body.referralCode.trim().toUpperCase() : '';

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, '이미 가입된 이메일입니다.');
    if (db.prepare('SELECT 1 FROM users WHERE nickname = ?').get(nickname)) throw httpError(409, '이미 사용 중인 닉네임입니다.');
    const referrer = refCode ? db.prepare('SELECT id, nickname FROM users WHERE referral_code = ?').get(refCode) : null;
    if (refCode && !referrer) throw httpError(400, '존재하지 않는 추천인 코드입니다.');

    const p = config.points;
    const userId = tx(db, () => {
      let code;
      do code = store.makeReferralCode();
      while (db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code));
      const r = db
        .prepare(
          `INSERT INTO users (email, password, nickname, child_stage, region, referral_code, referred_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(email, store.hashPassword(password), nickname, childStage, region, code, referrer?.id ?? null);
      const id = Number(r.lastInsertRowid);
      addPoints(db, id, p.signup, 'signup', '가입 축하 포인트');
      if (referrer) {
        addPoints(db, id, p.referee, 'referral', `추천인(${referrer.nickname}) 코드 가입 보너스`);
        addPoints(db, referrer.id, p.referrer, 'referral', `친구 초대 보상 (${nickname}님 가입)`);
      }
      return id;
    });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.status(201).json({ token: createSession(userId), user: publicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !store.verifyPassword(String(req.body.password || ''), user.password)) {
      throw httpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    res.json({ token: createSession(user.id), user: publicUser(user) });
  });

  app.post('/api/auth/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    const { c: referrals } = db.prepare('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?').get(req.user.id);
    res.json({ user: publicUser(req.user), referrals });
  });

  // ── 출석체크 ───────────────────────────────────────────
  app.post('/api/attendance', requireUser, (req, res) => {
    const today = store.kstToday();
    const u = req.user;
    if (u.last_attendance === today) throw httpError(400, '오늘은 이미 출석했어요. 내일 또 만나요!');
    const yesterday = new Date(Date.parse(today) - 86400 * 1000).toISOString().slice(0, 10);
    const streak = u.last_attendance === yesterday ? u.attendance_streak + 1 : 1;
    const p = config.points;
    let earned = p.attendance;
    tx(db, () => {
      db.prepare('UPDATE users SET last_attendance = ?, attendance_streak = ? WHERE id = ?').run(today, streak, u.id);
      addPoints(db, u.id, p.attendance, 'attendance', `출석체크 (${streak}일 연속)`);
      if (streak % 7 === 0) {
        addPoints(db, u.id, p.attendanceStreak7, 'attendance', `${streak}일 연속 출석 보너스`);
        earned += p.attendanceStreak7;
      }
    });
    res.json({ streak, earned });
  });

  // ── 홈 ────────────────────────────────────────────────
  const postListSql = `
    SELECT p.id, p.category, p.title, p.views, p.created_at, u.nickname, u.child_stage,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
    FROM posts p JOIN users u ON u.id = p.user_id`;

  app.get('/api/home', (req, res) => {
    store.ensureWeeklyEvent(db);
    const { start } = store.kstWeekRange();
    res.json({
      notices: db.prepare(`${postListSql} WHERE p.category = '공지' ORDER BY p.id DESC LIMIT 3`).all(),
      latest: db.prepare(`${postListSql} WHERE p.category != '공지' ORDER BY p.id DESC LIMIT 8`).all(),
      popular: db
        .prepare(
          `${postListSql} WHERE p.category != '공지' AND p.created_at >= datetime('now', '-7 days')
           ORDER BY like_count * 3 + comment_count * 2 + p.views DESC LIMIT 5`
        )
        .all(),
      events: db.prepare("SELECT * FROM events WHERE status = 'open' ORDER BY kind = 'weekly' DESC, id DESC LIMIT 4").all(),
      ranking: db
        .prepare(
          `SELECT u.nickname, u.child_stage, SUM(t.amount) AS earned
           FROM point_transactions t JOIN users u ON u.id = t.user_id
           WHERE t.amount > 0 AND t.kst_date >= ? AND u.role = 'member'
             AND t.type IN ('post', 'comment', 'like_received', 'event', 'event_prize', 'referral', 'attendance')
           GROUP BY u.id ORDER BY earned DESC LIMIT 5`
        )
        .all(start),
      stats: {
        members: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'member'").get().c,
        posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
        rewards: db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM point_transactions WHERE amount > 0").get().s,
      },
    });
  });

  // ── 게시판 ─────────────────────────────────────────────
  app.get('/api/posts', (req, res) => {
    const pageSize = 15;
    const page = Math.max(1, Number(req.query.page) || 1);
    const where = [];
    const args = [];
    if (CATEGORIES.includes(req.query.category)) {
      where.push('p.category = ?');
      args.push(req.query.category);
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      where.push('(p.title LIKE ? OR p.content LIKE ?)');
      const q = `%${req.query.q.trim().slice(0, 50)}%`;
      args.push(q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = req.query.sort === 'popular' ? 'like_count DESC, comment_count DESC, p.id DESC' : 'p.id DESC';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM posts p ${whereSql}`).get(...args).c;
    const posts = db
      .prepare(`${postListSql} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    res.json({ posts, page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total });
  });

  app.get('/api/posts/:id', (req, res) => {
    const id = int(req.params.id, '게시글 번호');
    db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(id);
    const post = db
      .prepare(
        `SELECT p.*, u.nickname, u.child_stage, u.region,
          (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
         FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`
      )
      .get(id);
    if (!post) throw httpError(404, '게시글을 찾을 수 없습니다.');
    const comments = db
      .prepare(
        `SELECT c.id, c.content, c.created_at, c.user_id, u.nickname, u.child_stage
         FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id`
      )
      .all(id);
    const liked = req.user ? !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(id, req.user.id) : false;
    res.json({ post, comments, liked });
  });

  app.post('/api/posts', requireUser, (req, res) => {
    const category = req.body.category;
    if (!CATEGORIES.includes(category)) throw httpError(400, '카테고리를 선택해 주세요.');
    if (category === '공지' && req.user.role !== 'admin') throw httpError(403, '공지는 운영자만 작성할 수 있습니다.');
    const title = text(req.body.title, '제목', 2, 100);
    const content = text(req.body.content, '내용', 10, 10000);
    const result = tx(db, () => {
      const r = db.prepare('INSERT INTO posts (user_id, category, title, content) VALUES (?, ?, ?, ?)').run(req.user.id, category, title, content);
      const id = Number(r.lastInsertRowid);
      const earned = addDailyCappedPoints(db, req.user.id, config.points.post, `게시글 작성: ${title.slice(0, 30)}`);
      return { id, earned };
    });
    res.status(201).json(result);
  });

  app.delete('/api/posts/:id', requireUser, (req, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(int(req.params.id, '게시글 번호'));
    if (!post) throw httpError(404, '게시글을 찾을 수 없습니다.');
    if (post.user_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '삭제 권한이 없습니다.');
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/comments', requireUser, (req, res) => {
    const post = db.prepare('SELECT id, title FROM posts WHERE id = ?').get(int(req.params.id, '게시글 번호'));
    if (!post) throw httpError(404, '게시글을 찾을 수 없습니다.');
    const content = text(req.body.content, '댓글', 2, 1000);
    const earned = tx(db, () => {
      db.prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)').run(post.id, req.user.id, content);
      return addDailyCappedPoints(db, req.user.id, config.points.comment, `댓글 작성: ${post.title.slice(0, 30)}`);
    });
    res.status(201).json({ earned });
  });

  app.delete('/api/comments/:id', requireUser, (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(int(req.params.id, '댓글 번호'));
    if (!c) throw httpError(404, '댓글을 찾을 수 없습니다.');
    if (c.user_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '삭제 권한이 없습니다.');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  // 공감은 한 번만 가능 (취소 후 재공감으로 포인트를 반복 적립하는 것을 방지)
  app.post('/api/posts/:id/like', requireUser, (req, res) => {
    const post = db.prepare('SELECT id, user_id, title FROM posts WHERE id = ?').get(int(req.params.id, '게시글 번호'));
    if (!post) throw httpError(404, '게시글을 찾을 수 없습니다.');
    tx(db, () => {
      const r = db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
      if (r.changes === 0) throw httpError(400, '이미 공감한 글이에요.');
      if (post.user_id !== req.user.id) {
        addDailyCappedPoints(db, post.user_id, config.points.likeReceived, `내 글 공감 받음: ${post.title.slice(0, 30)}`);
      }
    });
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(post.id);
    res.json({ likeCount: c });
  });

  // ── 이벤트 ─────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    store.ensureWeeklyEvent(db);
    const events = db
      .prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM event_entries x WHERE x.event_id = e.id) AS entry_count
         FROM events e ORDER BY e.status = 'open' DESC, e.id DESC LIMIT 50`
      )
      .all();
    res.json({ events });
  });

  app.get('/api/events/:id', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(int(req.params.id, '이벤트 번호'));
    if (!event) throw httpError(404, '이벤트를 찾을 수 없습니다.');
    const entries = db
      .prepare(
        `SELECT x.id, x.content, x.is_winner, x.created_at, u.nickname, u.child_stage
         FROM event_entries x JOIN users u ON u.id = x.user_id
         WHERE x.event_id = ? ORDER BY x.is_winner DESC, x.id DESC`
      )
      .all(event.id);
    const mine = req.user ? db.prepare('SELECT * FROM event_entries WHERE event_id = ? AND user_id = ?').get(event.id, req.user.id) : null;
    res.json({ event, entries, joined: !!mine });
  });

  app.post('/api/events/:id/entries', requireUser, (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(int(req.params.id, '이벤트 번호'));
    if (!event) throw httpError(404, '이벤트를 찾을 수 없습니다.');
    const today = store.kstToday();
    if (event.status !== 'open' || today < event.start_date || today > event.end_date) {
      throw httpError(400, '참여 기간이 아닌 이벤트입니다.');
    }
    const content = text(req.body.content, '참여 내용', 10, 2000);
    tx(db, () => {
      const r = db.prepare('INSERT OR IGNORE INTO event_entries (event_id, user_id, content) VALUES (?, ?, ?)').run(event.id, req.user.id, content);
      if (r.changes === 0) throw httpError(400, '이미 참여한 이벤트입니다.');
      if (event.participation_points > 0) {
        addPoints(db, req.user.id, event.participation_points, 'event', `이벤트 참여: ${event.title}`);
      }
    });
    res.status(201).json({ earned: event.participation_points });
  });

  // ── 포인트 / 상점 / 출금 ────────────────────────────────
  app.get('/api/me/points', requireUser, (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const items = db
      .prepare('SELECT id, amount, balance, type, description, created_at FROM point_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20 OFFSET ?')
      .all(req.user.id, (page - 1) * 20);
    const summary = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS earned,
                COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS spent
         FROM point_transactions WHERE user_id = ?`
      )
      .get(req.user.id);
    res.json({ items, page, balance: req.user.points, ...summary });
  });

  app.get('/api/me/referrals', requireUser, (req, res) => {
    const list = db
      .prepare('SELECT nickname, created_at FROM users WHERE referred_by = ? ORDER BY id DESC LIMIT 100')
      .all(req.user.id);
    res.json({ code: req.user.referral_code, list, rewardPerFriend: config.points.referrer });
  });

  app.get('/api/products', (req, res) => {
    res.json({ products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY price').all() });
  });

  app.post('/api/orders', requireUser, (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(int(req.body.productId, '상품'));
    if (!product) throw httpError(404, '상품을 찾을 수 없습니다.');
    const recipient = text(req.body.recipient, '받는 분 이름', 2, 20);
    const phone = text(req.body.phone, '연락처', 9, 20);
    if (!/^[0-9-]+$/.test(phone)) throw httpError(400, '연락처는 숫자와 - 만 입력해 주세요.');
    const address = product.needs_address ? text(req.body.address, '배송 주소', 5, 200) : null;
    const orderId = tx(db, () => {
      const r = db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0').run(product.id);
      if (r.changes === 0) throw httpError(400, '품절된 상품입니다.');
      addPoints(db, req.user.id, -product.price, 'shop', `상품 교환: ${product.name}`);
      return Number(
        db
          .prepare('INSERT INTO orders (user_id, product_id, price, recipient, phone, address) VALUES (?, ?, ?, ?, ?, ?)')
          .run(req.user.id, product.id, product.price, recipient, phone, address).lastInsertRowid
      );
    });
    res.status(201).json({ orderId });
  });

  app.get('/api/me/orders', requireUser, (req, res) => {
    res.json({
      orders: db
        .prepare(
          `SELECT o.*, p.name, p.emoji FROM orders o JOIN products p ON p.id = o.product_id
           WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 50`
        )
        .all(req.user.id),
    });
  });

  app.get('/api/me/withdrawals', requireUser, (req, res) => {
    res.json({
      withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id),
    });
  });

  app.post('/api/withdrawals', requireUser, (req, res) => {
    const w = config.withdrawal;
    const amount = int(req.body.amount, '출금 포인트');
    if (amount < w.minimum) throw httpError(400, `최소 ${w.minimum.toLocaleString()}P 부터 출금할 수 있습니다.`);
    if (amount % 1000 !== 0) throw httpError(400, '출금은 1,000P 단위로 신청할 수 있습니다.');
    if (!BANKS.includes(req.body.bank)) throw httpError(400, '은행을 선택해 주세요.');
    const accountNumber = text(req.body.accountNumber, '계좌번호', 8, 20).replace(/\s/g, '');
    if (!/^[0-9-]+$/.test(accountNumber)) throw httpError(400, '계좌번호는 숫자와 - 만 입력해 주세요.');
    const accountHolder = text(req.body.accountHolder, '예금주', 2, 20);

    const ageDays = (Date.now() - Date.parse(req.user.created_at + 'Z')) / 86400000;
    if (ageDays < w.minAccountAgeDays) throw httpError(400, `가입 후 ${w.minAccountAgeDays}일이 지나야 출금할 수 있습니다.`);
    const { c: todayCount } = db
      .prepare("SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ? AND type = 'withdrawal' AND kst_date = ?")
      .get(req.user.id, store.kstToday());
    if (todayCount >= w.dailyLimit) throw httpError(400, '출금 신청은 하루 1회만 가능합니다.');
    if (db.prepare("SELECT 1 FROM withdrawals WHERE user_id = ? AND status = 'pending'").get(req.user.id)) {
      throw httpError(400, '처리 대기 중인 출금 신청이 있습니다.');
    }

    const payout = (amount - w.fee) * w.pointToWon;
    const id = tx(db, () => {
      addPoints(db, req.user.id, -amount, 'withdrawal', `현금 출금 신청 (${req.body.bank} ${accountNumber.slice(-4).padStart(accountNumber.length, '*')})`);
      return Number(
        db
          .prepare('INSERT INTO withdrawals (user_id, amount, fee, payout, bank, account_number, account_holder) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(req.user.id, amount, w.fee, payout, req.body.bank, accountNumber, accountHolder).lastInsertRowid
      );
    });
    res.status(201).json({ id, payout });
  });

  // ── 관리자 ─────────────────────────────────────────────
  const admin = express.Router();
  admin.use(requireUser, requireAdmin);

  admin.get('/stats', (req, res) => {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    res.json({
      members: one("SELECT COUNT(*) AS c FROM users WHERE role = 'member'").c,
      todaySignups: one("SELECT COUNT(*) AS c FROM users WHERE role = 'member' AND date(created_at, '+9 hours') = ?", store.kstToday()).c,
      posts: one('SELECT COUNT(*) AS c FROM posts').c,
      pointsOutstanding: one("SELECT COALESCE(SUM(points), 0) AS s FROM users WHERE role = 'member'").s,
      pendingWithdrawals: one("SELECT COUNT(*) AS c, COALESCE(SUM(payout), 0) AS s FROM withdrawals WHERE status = 'pending'"),
      pendingOrders: one("SELECT COUNT(*) AS c FROM orders WHERE status = 'requested'").c,
      paidTotal: one("SELECT COALESCE(SUM(payout), 0) AS s FROM withdrawals WHERE status = 'paid'").s,
    });
  });

  admin.get('/users', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json({
      users: db
        .prepare(
          `SELECT u.id, u.email, u.nickname, u.role, u.points, u.region, u.child_stage, u.created_at,
            (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id) AS referrals
           FROM users u WHERE u.email LIKE ? OR u.nickname LIKE ? ORDER BY u.id DESC LIMIT 100`
        )
        .all(q, q),
    });
  });

  admin.post('/users/:id/points', (req, res) => {
    const userId = int(req.params.id, '회원 번호');
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount === 0) throw httpError(400, '지급/차감 포인트를 입력해 주세요.');
    const reason = text(req.body.reason, '사유', 2, 100);
    const balance = tx(db, () => addPoints(db, userId, amount, 'admin', `운영자 조정: ${reason}`));
    res.json({ balance });
  });

  admin.get('/withdrawals', (req, res) => {
    const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    res.json({
      withdrawals: db
        .prepare(
          `SELECT w.*, u.nickname, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
           WHERE w.status = ? ORDER BY w.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`
        )
        .all(status),
    });
  });

  admin.post('/withdrawals/:id', (req, res) => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(int(req.params.id, '출금 번호'));
    if (!w) throw httpError(404, '출금 신청을 찾을 수 없습니다.');
    if (w.status !== 'pending') throw httpError(400, '이미 처리된 신청입니다.');
    const action = req.body.action;
    if (!['paid', 'rejected'].includes(action)) throw httpError(400, '처리 상태가 올바르지 않습니다.');
    const memo = typeof req.body.memo === 'string' ? req.body.memo.trim().slice(0, 200) : null;
    tx(db, () => {
      db.prepare("UPDATE withdrawals SET status = ?, admin_memo = ?, processed_at = datetime('now') WHERE id = ?").run(action, memo, w.id);
      if (action === 'rejected') {
        addPoints(db, w.user_id, w.amount, 'withdrawal_refund', `출금 반려 환불${memo ? ` (${memo})` : ''}`);
      }
    });
    res.json({ ok: true });
  });

  admin.get('/orders', (req, res) => {
    res.json({
      orders: db
        .prepare(
          `SELECT o.*, p.name, p.emoji, u.nickname FROM orders o
           JOIN products p ON p.id = o.product_id JOIN users u ON u.id = o.user_id
           ORDER BY o.status = 'requested' DESC, o.id DESC LIMIT 200`
        )
        .all(),
    });
  });

  admin.post('/orders/:id', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(int(req.params.id, '주문 번호'));
    if (!o) throw httpError(404, '주문을 찾을 수 없습니다.');
    if (o.status !== 'requested') throw httpError(400, '이미 처리된 주문입니다.');
    const action = req.body.action;
    if (!['sent', 'canceled'].includes(action)) throw httpError(400, '처리 상태가 올바르지 않습니다.');
    tx(db, () => {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(action, o.id);
      if (action === 'canceled') {
        db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(o.product_id);
        addPoints(db, o.user_id, o.price, 'shop_refund', `상품 교환 취소 환불 (주문 #${o.id})`);
      }
    });
    res.json({ ok: true });
  });

  admin.post('/products', (req, res) => {
    const name = text(req.body.name, '상품명', 2, 50);
    const description = text(req.body.description, '설명', 2, 200);
    const category = text(req.body.category, '분류', 1, 20);
    const emoji = typeof req.body.emoji === 'string' && req.body.emoji.trim() ? req.body.emoji.trim().slice(0, 4) : '🎁';
    const price = int(req.body.price, '가격');
    const stock = int(req.body.stock, '재고', 0);
    const r = db
      .prepare('INSERT INTO products (name, description, category, emoji, price, stock, needs_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, description, category, emoji, price, stock, req.body.needsAddress ? 1 : 0);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  admin.patch('/products/:id', (req, res) => {
    const id = int(req.params.id, '상품 번호');
    if (req.body.stock !== undefined) db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(int(req.body.stock, '재고', 0), id);
    if (req.body.active !== undefined) db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
    res.json({ ok: true });
  });

  admin.get('/products', (req, res) => {
    res.json({ products: db.prepare('SELECT * FROM products ORDER BY active DESC, id').all() });
  });

  admin.post('/events', (req, res) => {
    const title = text(req.body.title, '이벤트명', 2, 60);
    const description = text(req.body.description, '이벤트 설명', 10, 2000);
    const startDate = text(req.body.startDate, '시작일', 10, 10);
    const endDate = text(req.body.endDate, '종료일', 10, 10);
    if (!(startDate <= endDate)) throw httpError(400, '종료일이 시작일보다 빠릅니다.');
    const r = db
      .prepare(
        `INSERT INTO events (title, description, kind, emoji, start_date, end_date, participation_points, prize_points, winners_count)
         VALUES (?, ?, 'special', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        description,
        (typeof req.body.emoji === 'string' && req.body.emoji.trim().slice(0, 4)) || '🎉',
        startDate,
        endDate,
        int(req.body.participationPoints ?? 0, '참여 포인트', 0),
        int(req.body.prizePoints ?? 0, '당첨 포인트', 0),
        int(req.body.winnersCount ?? 1, '당첨자 수', 1)
      );
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // 당첨자 추첨: 지정 당첨자(entryIds)가 없으면 무작위 추첨 후 이벤트 마감
  admin.post('/events/:id/draw', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(int(req.params.id, '이벤트 번호'));
    if (!event) throw httpError(404, '이벤트를 찾을 수 없습니다.');
    if (event.status !== 'open') throw httpError(400, '이미 마감된 이벤트입니다.');
    const entries = db.prepare('SELECT * FROM event_entries WHERE event_id = ?').all(event.id);
    let winners;
    if (Array.isArray(req.body.entryIds) && req.body.entryIds.length) {
      const ids = new Set(req.body.entryIds.map(Number));
      winners = entries.filter((e) => ids.has(e.id));
    } else {
      winners = [...entries];
      for (let i = winners.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [winners[i], winners[j]] = [winners[j], winners[i]];
      }
      winners = winners.slice(0, event.winners_count);
    }
    tx(db, () => {
      for (const w of winners) {
        db.prepare('UPDATE event_entries SET is_winner = 1 WHERE id = ?').run(w.id);
        if (event.prize_points > 0) addPoints(db, w.user_id, event.prize_points, 'event_prize', `이벤트 당첨: ${event.title}`);
      }
      db.prepare("UPDATE events SET status = 'closed' WHERE id = ?").run(event.id);
    });
    res.json({ winners: winners.length });
  });

  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API 입니다.' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message });
  });

  return app;
}

if (require.main === module) {
  const db = store.open();
  createApp(db).listen(config.port, () => {
    console.log(`${config.siteName} 실행 중 → http://localhost:${config.port}`);
  });
}

module.exports = { createApp };

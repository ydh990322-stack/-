const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../db');
const config = require('../config');
const { createApp } = require('../server');

let server;
let base;
let db;

before(async () => {
  db = store.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(path, { token, body, method } = {}) {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function signup(nickname, extra = {}) {
  const r = await call('/auth/signup', { body: { email: `${nickname}@test.kr`, password: 'password1', nickname, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

const p = config.points;

test('가입 + 추천인 보상', async () => {
  const a = await signup('엄마A');
  assert.equal(a.user.points, p.signup);
  const b = await signup('아빠B', { referralCode: a.user.referralCode });
  assert.equal(b.user.points, p.signup + p.referee);
  const me = await call('/me', { token: a.token });
  assert.equal(me.data.user.points, p.signup + p.referrer);
  assert.equal(me.data.referrals, 1);

  const bad = await call('/auth/signup', { body: { email: 'x@test.kr', password: 'password1', nickname: '엑스', referralCode: 'NOPE' } });
  assert.equal(bad.status, 400);
  const dup = await call('/auth/signup', { body: { email: '엄마A@test.kr', password: 'password1', nickname: '다른이름' } });
  assert.equal(dup.status, 409);
});

test('출석은 하루 한 번', async () => {
  const u = await signup('출석맘');
  const r1 = await call('/attendance', { token: u.token, method: 'POST' });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.earned, p.attendance);
  const r2 = await call('/attendance', { token: u.token, method: 'POST' });
  assert.equal(r2.status, 400);
});

test('글/댓글 포인트 하루 한도, 공감은 1회', async () => {
  const u = await signup('글쓴이');
  const other = await signup('공감러');
  let firstId;
  for (let i = 0; i < p.post.dailyLimit + 1; i++) {
    const r = await call('/posts', { token: u.token, body: { category: '육아정보', title: `꿀팁 ${i}`, content: '아이 재우는 꿀팁 공유합니다.' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.earned, i < p.post.dailyLimit ? p.post.points : 0);
    firstId ??= r.data.id;
  }
  const notice = await call('/posts', { token: u.token, body: { category: '공지', title: '공지', content: '일반회원은 공지 불가' } });
  assert.equal(notice.status, 403);

  const c = await call(`/posts/${firstId}/comments`, { token: other.token, body: { content: '좋은 정보 감사해요' } });
  assert.equal(c.data.earned, p.comment.points);

  const l1 = await call(`/posts/${firstId}/like`, { token: other.token, method: 'POST' });
  assert.equal(l1.data.likeCount, 1);
  const l2 = await call(`/posts/${firstId}/like`, { token: other.token, method: 'POST' });
  assert.equal(l2.status, 400);

  const me = await call('/me', { token: u.token });
  assert.equal(me.data.user.points, p.signup + p.post.points * p.post.dailyLimit + p.likeReceived.points);

  const detail = await call(`/posts/${firstId}`);
  assert.equal(detail.data.comments.length, 1);
  const xss = await call('/posts?q=<script>');
  assert.equal(xss.status, 200);
});

test('이벤트 참여 + 관리자 추첨', async () => {
  const admin = (await call('/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).data;
  const u = await signup('이벤트맘');
  const { events } = (await call('/events')).data;
  const weekly = events.find((e) => e.kind === 'weekly');
  assert.ok(weekly, '이번 주 정기 이벤트 자동 생성');

  const e1 = await call(`/events/${weekly.id}/entries`, { token: u.token, body: { content: '아이가 잘 자는 꿀팁은 백색소음!' } });
  assert.equal(e1.status, 201);
  const e2 = await call(`/events/${weekly.id}/entries`, { token: u.token, body: { content: '한 번 더 참여해볼게요!!' } });
  assert.equal(e2.status, 400);

  const notAdmin = await call(`/admin/events/${weekly.id}/draw`, { token: u.token, body: {} });
  assert.equal(notAdmin.status, 403);
  const draw = await call(`/admin/events/${weekly.id}/draw`, { token: admin.token, body: {} });
  assert.equal(draw.data.winners, 1);
  const me = await call('/me', { token: u.token });
  assert.equal(me.data.user.points, p.signup + p.eventEntry + p.weeklyPrize);
});

test('상품 교환 + 취소 환불', async () => {
  const admin = (await call('/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).data;
  const u = await signup('쇼핑맘');
  const { products } = (await call('/products')).data;
  await call(`/admin/users/${u.user.id}/points`, { token: admin.token, body: { amount: 5000, reason: '테스트 지급' } });
  const have = p.signup + 5000;
  const cheap = products.find((x) => x.price <= have && !x.needs_address);
  const pricey = products.find((x) => x.price > have);

  const fail = await call('/orders', { token: u.token, body: { productId: pricey.id, recipient: '홍길동', phone: '010-1234-5678', address: '서울시 어딘가 123' } });
  assert.equal(fail.status, 400);

  const ok = await call('/orders', { token: u.token, body: { productId: cheap.id, recipient: '홍길동', phone: '010-1234-5678' } });
  assert.equal(ok.status, 201);
  assert.equal((await call('/me', { token: u.token })).data.user.points, have - cheap.price);

  const cancel = await call(`/admin/orders/${ok.data.orderId}`, { token: admin.token, body: { action: 'canceled' } });
  assert.equal(cancel.status, 200);
  assert.equal((await call('/me', { token: u.token })).data.user.points, have);
});

test('현금 출금: 조건 검사, 반려 시 환불, 지급 처리', async () => {
  const admin = (await call('/auth/login', { body: { email: config.admin.email, password: config.admin.password } })).data;
  const u = await signup('출금아빠');
  const body = { amount: 10000, bank: '국민', accountNumber: '123456789012', accountHolder: '출금아빠' };

  let r = await call('/withdrawals', { token: u.token, body });
  assert.equal(r.status, 400); // 가입 7일 미만

  db.prepare("UPDATE users SET created_at = datetime('now', '-10 days') WHERE id = ?").run(u.user.id);
  r = await call('/withdrawals', { token: u.token, body });
  assert.equal(r.status, 400); // 포인트 부족

  await call(`/admin/users/${u.user.id}/points`, { token: admin.token, body: { amount: 20000, reason: '테스트 지급' } });
  r = await call('/withdrawals', { token: u.token, body: { ...body, amount: 10500 } });
  assert.equal(r.status, 400); // 1,000P 단위

  r = await call('/withdrawals', { token: u.token, body });
  assert.equal(r.status, 201);
  assert.equal(r.data.payout, 10000 - config.withdrawal.fee);
  assert.equal((await call('/me', { token: u.token })).data.user.points, p.signup + 20000 - 10000);

  r = await call('/withdrawals', { token: u.token, body });
  assert.equal(r.status, 400); // 하루 1회 / 대기중

  const list = (await call('/admin/withdrawals', { token: admin.token })).data.withdrawals;
  const mine = list.find((w) => w.user_id === u.user.id);
  r = await call(`/admin/withdrawals/${mine.id}`, { token: admin.token, body: { action: 'rejected', memo: '예금주 불일치' } });
  assert.equal(r.status, 200);
  assert.equal((await call('/me', { token: u.token })).data.user.points, p.signup + 20000);

  r = await call(`/admin/withdrawals/${mine.id}`, { token: admin.token, body: { action: 'paid' } });
  assert.equal(r.status, 400); // 이미 처리됨

  const ledger = (await call('/me/points', { token: u.token })).data;
  assert.equal(ledger.balance, p.signup + 20000);
  assert.equal(ledger.items[0].type, 'withdrawal_refund');
});

test('인증 필요 API는 401', async () => {
  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/withdrawals', { body: {} })).status, 401);
  assert.equal((await call('/admin/stats')).status, 401);
});

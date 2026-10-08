/* 맘앤대디 라운지 - 프론트엔드 (해시 라우팅 SPA, 빌드 도구 없이 동작) */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const state = { token: null, user: null, config: null };
  try { state.token = localStorage.getItem('token'); } catch (_) { /* 저장소 사용 불가 */ }

  // ── 유틸 ───────────────────────────────────────────────
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
  const toDate = (s) => new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  function ago(s) {
    const d = toDate(s);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
    return d.toLocaleDateString('ko-KR');
  }
  const dt = (s) => toDate(s).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !path.startsWith('/auth')) {
      setSession(null, null);
    }
    if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    try {
      if (token) localStorage.setItem('token', token);
      else localStorage.removeItem('token');
    } catch (_) { /* 무시 */ }
    renderUserbox();
  }

  async function refreshMe() {
    if (!state.token) return null;
    try {
      const { user } = await api('/me');
      state.user = user;
    } catch (_) {
      setSession(null, null);
    }
    renderUserbox();
    return state.user;
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  // form submit 공통 처리: 버튼 잠금 + 에러 토스트
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        await handler(formData(form), form);
      } catch (err) {
        toast(err.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  function requireLogin() {
    if (state.user) return true;
    toast('로그인이 필요해요.');
    location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`;
    return false;
  }

  function openModal(html, bind) {
    const m = document.getElementById('modal');
    m.innerHTML = `<div class="modal-box">${html}</div>`;
    m.hidden = false;
    m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); };
    if (bind) bind(m.querySelector('.modal-box'));
  }
  function closeModal() {
    const m = document.getElementById('modal');
    m.hidden = true;
    m.innerHTML = '';
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function inviteLink(code) {
    return `${location.origin}/#/signup?ref=${encodeURIComponent(code)}`;
  }

  async function share({ title, text, url }) {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return; } catch (_) { /* 취소 */ }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('링크가 복사됐어요! 카톡·맘카페에 붙여넣어 공유해 주세요.');
    } catch (_) {
      prompt('아래 링크를 복사해 공유해 주세요', url);
    }
  }

  const stageTag = (s) => (s ? `<span class="stage">${esc(s)}</span>` : '');
  const badge = (c) => `<span class="badge ${esc(c)}">${esc(c)}</span>`;

  function postItems(posts, { showCat = true } = {}) {
    if (!posts.length) return '<div class="empty">아직 글이 없어요. 첫 글의 주인공이 되어주세요! ✍️</div>';
    return `<ul class="post-list">${posts
      .map(
        (p) => `<li><a href="#/post/${p.id}">
          <div class="pt">${showCat ? badge(p.category) : ''}<span>${esc(p.title)}</span>${p.comment_count ? `<span class="cc">[${p.comment_count}]</span>` : ''}</div>
          <div class="pm"><span>${esc(p.nickname)} ${stageTag(p.child_stage)}</span><span>${ago(p.created_at)}</span><span>조회 ${fmt(p.views)}</span><span>♥ ${fmt(p.like_count)}</span></div>
        </a></li>`
      )
      .join('')}</ul>`;
  }

  function eventCard(e) {
    const open = e.status === 'open';
    return `<a class="event-card ${open ? '' : 'closed'}" href="#/event/${e.id}">
      <span class="kind badge ${e.kind === 'weekly' ? 'ok' : 'wait'}">${e.kind === 'weekly' ? '매주 이벤트' : '스페셜'}</span>
      <div class="em">${esc(e.emoji)}</div>
      <h3>${esc(e.title)}</h3>
      <div class="desc">${esc(e.description)}</div>
      <div class="reward">
        ${e.participation_points ? `<span>참여 +${fmt(e.participation_points)}P</span>` : ''}
        ${e.prize_points ? `<span>당첨 ${fmt(e.prize_points)}P × ${e.winners_count}명</span>` : ''}
      </div>
      <div class="small muted">${esc(e.start_date)} ~ ${esc(e.end_date)} ${open ? '' : '· 마감'}${e.entry_count != null ? ` · ${fmt(e.entry_count)}명 참여` : ''}</div>
    </a>`;
  }

  // ── 상단 사용자 영역 ─────────────────────────────────────
  function renderUserbox() {
    const box = document.getElementById('userbox');
    if (!state.user) {
      box.innerHTML = `<a class="btn ghost sm" href="#/login">로그인</a><a class="btn sm" href="#/signup">가입<span class="hide-m">하고 ${fmt(state.config?.points.signup)}P 받기</span></a>`;
      return;
    }
    box.innerHTML = `
      <a class="point-chip" href="#/me" title="내 포인트">💰 ${fmt(state.user.points)}P</a>
      ${state.user.role === 'admin' ? '<a class="btn soft sm hide-m" href="#/admin">관리자</a>' : ''}
      <a class="btn ghost sm hide-m" href="#/me">${esc(state.user.nickname)}</a>`;
  }

  async function attend(btn) {
    if (!requireLogin()) return;
    btn && (btn.disabled = true);
    try {
      const r = await api('/attendance', { method: 'POST' });
      toast(`출석 완료! +${fmt(r.earned)}P (${r.streak}일 연속) 🎉`);
      await refreshMe();
      route();
    } catch (err) {
      toast(err.message);
      btn && (btn.disabled = false);
    }
  }

  // ── 페이지 ─────────────────────────────────────────────
  const pages = {};

  pages.home = async () => {
    const d = await api('/home');
    const u = state.user;
    const cfg = state.config;
    const attendedToday = u && u.lastAttendance === new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const hero = u
      ? `<section class="card mybox" style="margin-bottom:20px">
          <div>
            <div class="muted small">${esc(u.nickname)}님, 오늘도 육아 화이팅! 💪</div>
            <div class="bal">💰 ${fmt(u.points)}P</div>
            <div class="small muted">출석 ${fmt(u.attendanceStreak)}일 연속 · 7일 연속 출석 시 +${fmt(cfg.points.attendanceStreak7)}P 보너스</div>
          </div>
          <div class="row">
            <button class="btn ${attendedToday ? 'ghost' : ''}" id="attend" ${attendedToday ? 'disabled' : ''}>${attendedToday ? '✅ 오늘 출석 완료' : `📅 출석체크 +${cfg.points.attendance}P`}</button>
            <a class="btn soft" href="#/shop">포인트샵</a>
          </div>
        </section>`
      : `<section class="hero">
          <div class="hero-deco">👶</div>
          <h1>육아, 혼자 하지 마세요.<br/>엄마·아빠들의 따뜻한 라운지</h1>
          <p>육아 정보를 나누고, 고민을 털어놓고, 매주 이벤트에 참여하세요.<br/>활동할수록 쌓이는 포인트로 육아용품 교환·현금 출금까지!</p>
          <div class="row">
            <a class="btn" href="#/signup">지금 가입하고 ${fmt(cfg.points.signup)}P 받기</a>
            <a class="btn ghost" href="#/guide">포인트 제도 보기</a>
          </div>
          <div class="hero-stats">
            <div><b>${fmt(d.stats.members)}</b><span>함께하는 엄마·아빠</span></div>
            <div><b>${fmt(d.stats.posts)}</b><span>공유된 육아 이야기</span></div>
            <div><b>${fmt(d.stats.rewards)}P</b><span>지금까지 지급된 포인트</span></div>
          </div>
        </section>`;

    $app.innerHTML = `
      ${hero}
      <section class="feature-grid">
        <a class="feature" href="#/board?category=육아정보"><span class="ico">📚</span><b>육아정보</b><span>검증된 꿀팁과 노하우</span></a>
        <a class="feature" href="#/board?category=질문답변"><span class="ico">🙋</span><b>질문답변</b><span>선배 맘·대디에게 물어보세요</span></a>
        <a class="feature" href="#/events"><span class="ico">🎉</span><b>매주 이벤트</b><span>참여만 해도 포인트 적립</span></a>
        <a class="feature" href="#/me"><span class="ico">💌</span><b>친구 초대</b><span>초대할 때마다 +${fmt(cfg.points.referrer)}P</span></a>
      </section>
      <div class="layout">
        <div class="stack">
          ${d.notices.length ? `<section class="card"><div class="card-title"><h2>📢 공지사항</h2><a href="#/board?category=공지">더보기</a></div>${postItems(d.notices, { showCat: false })}</section>` : ''}
          <section class="card">
            <div class="card-title"><h2>🎉 진행 중인 이벤트</h2><a href="#/events">전체보기</a></div>
            <div class="event-grid">${d.events.map(eventCard).join('') || '<div class="empty">진행 중인 이벤트가 없어요.</div>'}</div>
          </section>
          <section class="card">
            <div class="card-title"><h2>🔥 이번 주 인기글</h2><a href="#/board?sort=popular">더보기</a></div>
            ${postItems(d.popular)}
          </section>
          <section class="card">
            <div class="card-title"><h2>🆕 새로운 이야기</h2><a href="#/board">더보기</a></div>
            ${postItems(d.latest)}
          </section>
        </div>
        <aside class="stack">
          <section class="card">
            <div class="card-title"><h3>🏆 이번 주 활동왕</h3></div>
            ${d.ranking.length
              ? `<ol class="rank">${d.ranking.map((r, i) => `<li><span class="no">${i + 1}</span><span class="nm">${esc(r.nickname)} ${stageTag(r.child_stage)}</span><b class="small">${fmt(r.earned)}P</b></li>`).join('')}</ol>`
              : '<div class="empty small">이번 주 첫 활동왕에 도전하세요!</div>'}
          </section>
          <section class="card invite">
            <div class="card-title"><h3>💌 친구 초대하고 포인트 받기</h3></div>
            <p class="small" style="margin:0 0 12px">초대 링크로 친구가 가입하면<br/>나는 <b>${fmt(cfg.points.referrer)}P</b>, 친구는 <b>${fmt(cfg.points.referee)}P</b> 추가 적립!</p>
            <button class="btn block" style="background:var(--purple)" id="invite-btn">초대 링크 공유하기</button>
          </section>
          <section class="card">
            <div class="card-title"><h3>💰 포인트 모으는 법</h3><a href="#/guide">자세히</a></div>
            <ul class="small" style="margin:0;padding-left:18px">
              <li>매일 출석체크 +${cfg.points.attendance}P</li>
              <li>글쓰기 +${cfg.points.post.points}P · 댓글 +${cfg.points.comment.points}P</li>
              <li>매주 이벤트 참여 +${cfg.points.eventEntry}P</li>
              <li>${fmt(cfg.withdrawal.minimum)}P부터 현금 출금 가능</li>
            </ul>
          </section>
        </aside>
      </div>`;

    document.getElementById('attend')?.addEventListener('click', (e) => attend(e.currentTarget));
    document.getElementById('invite-btn').addEventListener('click', () => {
      if (!requireLogin()) return;
      share({ title: cfg.siteName, text: `육아하는 엄마·아빠 커뮤니티 ${cfg.siteName}! 이 링크로 가입하면 보너스 포인트를 받아요 🎁`, url: inviteLink(state.user.referralCode) });
    });
  };

  pages.board = async (params) => {
    const category = params.get('category') || '';
    const q = params.get('q') || '';
    const sort = params.get('sort') || '';
    const page = Number(params.get('page')) || 1;
    const qs = new URLSearchParams({ page });
    if (category) qs.set('category', category);
    if (q) qs.set('q', q);
    if (sort) qs.set('sort', sort);
    const d = await api(`/posts?${qs}`);
    const link = (over) => {
      const p = new URLSearchParams({ ...(category && { category }), ...(q && { q }), ...(sort && { sort }), ...over });
      for (const [k, v] of [...p]) if (!v) p.delete(k);
      return `#/board?${p}`;
    };
    $app.innerHTML = `
      <div class="page-head">
        <div><h1>💬 커뮤니티</h1><p>육아 정보와 일상을 자유롭게 나눠요. 글쓰기 +${state.config.points.post.points}P · 댓글 +${state.config.points.comment.points}P</p></div>
        <a class="btn" href="#/write${category && category !== '공지' ? `?category=${encodeURIComponent(category)}` : ''}">✏️ 글쓰기</a>
      </div>
      <div class="tabs">
        <a class="tab ${!category ? 'active' : ''}" href="${link({ category: '', page: '' })}">전체</a>
        ${state.config.categories.map((c) => `<a class="tab ${c === category ? 'active' : ''}" href="${link({ category: c, page: '' })}">${esc(c)}</a>`).join('')}
      </div>
      <section class="card">
        <div class="row between" style="margin-bottom:6px">
          <div class="row small">
            <a href="${link({ sort: '', page: '' })}" style="${sort ? '' : 'font-weight:700'}">최신순</a> ·
            <a href="${link({ sort: 'popular', page: '' })}" style="${sort === 'popular' ? 'font-weight:700' : ''}">인기순</a>
            <span class="muted">총 ${fmt(d.total)}개</span>
          </div>
          <form id="search" class="row"><input class="input" name="q" value="${esc(q)}" placeholder="검색어 입력" style="width:180px;padding:7px 12px" /><button class="btn sm ghost">검색</button></form>
        </div>
        ${postItems(d.posts)}
        <div class="pager">${Array.from({ length: Math.min(d.totalPages, 10) }, (_, i) => {
          const start = Math.max(1, Math.min(page - 4, d.totalPages - 9));
          const n = start + i;
          return `<button data-page="${n}" class="${n === page ? 'active' : ''}">${n}</button>`;
        }).join('')}</div>
      </section>`;
    document.getElementById('search').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = link({ q: e.target.q.value.trim(), page: '' });
    });
    $app.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { location.hash = link({ page: b.dataset.page }); }));
  };

  pages.write = async (params) => {
    if (!requireLogin()) return;
    const pre = params.get('category');
    const cats = state.config.categories.filter((c) => c !== '공지' || state.user.role === 'admin');
    $app.innerHTML = `
      <div class="mid">
        <div class="page-head"><div><h1>✏️ 글쓰기</h1><p>따뜻한 말 한마디가 누군가에게 큰 힘이 돼요.</p></div></div>
        <form class="card form" id="wf">
          <div class="field"><label>카테고리</label>
            <select class="input" name="category" required>${cats.map((c) => `<option ${c === pre ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div class="field"><label>제목</label><input class="input" name="title" maxlength="100" required placeholder="제목을 입력해 주세요" /></div>
          <div class="field"><label>내용</label><textarea class="input" name="content" required minlength="10" style="min-height:280px" placeholder="경험과 정보를 자유롭게 나눠주세요. (욕설·비방·광고글은 삭제될 수 있어요)"></textarea></div>
          <div class="row between"><a class="btn ghost" href="#/board">취소</a><button class="btn" type="submit">등록하기</button></div>
        </form>
      </div>`;
    onSubmit(document.getElementById('wf'), async (data) => {
      const r = await api('/posts', { body: data });
      toast(r.earned ? `글이 등록됐어요! +${r.earned}P 적립 🎉` : '글이 등록됐어요! (오늘 글쓰기 포인트는 모두 받았어요)');
      await refreshMe();
      location.hash = `#/post/${r.id}`;
    });
  };

  pages.post = async (params, id) => {
    const d = await api(`/posts/${id}`);
    const p = d.post;
    const u = state.user;
    const canDelete = u && (u.id === p.user_id || u.role === 'admin');
    $app.innerHTML = `
      <div class="mid">
        <article class="card">
          <div class="post-head">
            <a href="#/board?category=${encodeURIComponent(p.category)}">${badge(p.category)}</a>
            <h1>${esc(p.title)}</h1>
            <div class="pm"><b>${esc(p.nickname)}</b> ${stageTag(p.child_stage)} ${p.region ? `<span>📍${esc(p.region)}</span>` : ''}<span>${dt(p.created_at)}</span><span>조회 ${fmt(p.views)}</span></div>
          </div>
          <div class="post-body">${esc(p.content)}</div>
          <div class="row between">
            <div class="row">
              <button class="btn ${d.liked ? 'ghost' : 'soft'}" id="like" ${d.liked ? 'disabled' : ''}>♥ 공감 <span id="lc">${fmt(p.like_count)}</span></button>
              <button class="btn ghost" id="share">🔗 공유하기</button>
            </div>
            <div class="row">
              ${canDelete ? '<button class="btn ghost sm" id="del">삭제</button>' : ''}
              <a class="btn ghost sm" href="#/board">목록</a>
            </div>
          </div>
        </article>
        <section class="card">
          <div class="card-title"><h3>댓글 ${fmt(d.comments.length)}</h3></div>
          ${d.comments.map((c) => `
            <div class="comment">
              <div class="row between"><span class="who">${esc(c.nickname)} ${stageTag(c.child_stage)}</span>
                <span class="row small muted">${ago(c.created_at)} ${u && (u.id === c.user_id || u.role === 'admin') ? `<button class="linkbtn" data-delc="${c.id}">삭제</button>` : ''}</span></div>
              <p>${esc(c.content)}</p>
            </div>`).join('') || '<div class="empty small">첫 댓글로 따뜻한 응원을 남겨주세요 💛</div>'}
          ${u
            ? `<form class="form" id="cf" style="margin-top:14px"><textarea class="input" name="content" required style="min-height:80px" placeholder="댓글을 남겨주세요 (+${state.config.points.comment.points}P)"></textarea><div class="row" style="justify-content:flex-end"><button class="btn" type="submit">댓글 등록</button></div></form>`
            : `<div class="empty small"><a class="btn soft sm" href="#/login?next=${encodeURIComponent(`/post/${p.id}`)}">로그인하고 댓글 쓰기</a></div>`}
        </section>
      </div>`;

    document.getElementById('like').addEventListener('click', async (e) => {
      if (!requireLogin()) return;
      try {
        const r = await api(`/posts/${p.id}/like`, { method: 'POST' });
        document.getElementById('lc').textContent = fmt(r.likeCount);
        e.currentTarget.disabled = true;
        e.currentTarget.className = 'btn ghost';
      } catch (err) { toast(err.message); }
    });
    document.getElementById('share').addEventListener('click', () => {
      const url = state.user ? `${location.origin}/#/post/${p.id}?ref=${state.user.referralCode}` : `${location.origin}/#/post/${p.id}`;
      share({ title: p.title, text: `[${state.config.siteName}] ${p.title}`, url });
    });
    document.getElementById('del')?.addEventListener('click', async () => {
      if (!confirm('이 글을 삭제할까요?')) return;
      try { await api(`/posts/${p.id}`, { method: 'DELETE' }); toast('삭제됐어요.'); location.hash = '#/board'; } catch (err) { toast(err.message); }
    });
    $app.querySelectorAll('[data-delc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('댓글을 삭제할까요?')) return;
      try { await api(`/comments/${b.dataset.delc}`, { method: 'DELETE' }); route(); } catch (err) { toast(err.message); }
    }));
    const cf = document.getElementById('cf');
    if (cf) onSubmit(cf, async (data) => {
      const r = await api(`/posts/${p.id}/comments`, { body: data });
      toast(r.earned ? `댓글 등록! +${r.earned}P` : '댓글이 등록됐어요.');
      await refreshMe();
      route();
    });
  };

  pages.events = async () => {
    const { events } = await api('/events');
    const open = events.filter((e) => e.status === 'open');
    const closed = events.filter((e) => e.status !== 'open');
    $app.innerHTML = `
      <div class="page-head"><div><h1>🎉 이벤트</h1><p>매주 월요일 새로운 정기 이벤트가 열려요. 참여만 해도 포인트, 당첨되면 더 큰 포인트!</p></div>
        ${state.user?.role === 'admin' ? '<a class="btn soft" href="#/admin?tab=events">이벤트 만들기</a>' : ''}</div>
      <section class="card">
        <div class="card-title"><h2>진행 중</h2></div>
        <div class="event-grid">${open.map(eventCard).join('') || '<div class="empty">진행 중인 이벤트가 없어요.</div>'}</div>
      </section>
      ${closed.length ? `<section class="card"><div class="card-title"><h2>지난 이벤트 · 당첨자 발표</h2></div><div class="event-grid">${closed.map(eventCard).join('')}</div></section>` : ''}`;
  };

  pages.event = async (params, id) => {
    const d = await api(`/events/${id}`);
    const e = d.event;
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const canJoin = e.status === 'open' && today >= e.start_date && today <= e.end_date;
    const isAdmin = state.user?.role === 'admin';
    $app.innerHTML = `
      <div class="mid">
        <section class="card">
          <div class="row between"><span class="badge ${e.kind === 'weekly' ? 'ok' : 'wait'}">${e.kind === 'weekly' ? '매주 이벤트' : '스페셜 이벤트'}</span><span class="small muted">${esc(e.start_date)} ~ ${esc(e.end_date)}</span></div>
          <div style="font-size:48px;margin-top:10px">${esc(e.emoji)}</div>
          <h1 style="font-size:24px;font-weight:800">${esc(e.title)}</h1>
          <p style="white-space:pre-wrap">${esc(e.description)}</p>
          <div class="reward" style="margin-bottom:14px">
            ${e.participation_points ? `<span>참여 즉시 +${fmt(e.participation_points)}P</span>` : ''}
            ${e.prize_points ? `<span>당첨 ${fmt(e.prize_points)}P × ${e.winners_count}명</span>` : ''}
          </div>
          ${d.joined ? '<div class="notice-box">✅ 이미 참여하셨어요! 당첨 발표를 기다려 주세요.</div>'
            : canJoin ? (state.user
              ? `<form class="form" id="ef"><textarea class="input" name="content" required minlength="10" placeholder="이벤트 참여 내용을 작성해 주세요 (10자 이상)"></textarea><button class="btn block" type="submit">참여하기 ${e.participation_points ? `(+${fmt(e.participation_points)}P)` : ''}</button></form>`
              : `<a class="btn block" href="#/login?next=${encodeURIComponent(`/event/${e.id}`)}">로그인하고 참여하기</a>`)
            : '<div class="notice-box">참여 기간이 종료된 이벤트입니다.</div>'}
          <div class="row" style="margin-top:12px">
            <button class="btn ghost sm" id="share">🔗 친구에게 이벤트 알리기</button>
            ${isAdmin && e.status === 'open' ? '<button class="btn danger sm" id="draw">당첨자 무작위 추첨 & 마감</button>' : ''}
          </div>
        </section>
        <section class="card">
          <div class="card-title"><h3>참여 현황 ${fmt(d.entries.length)}명</h3></div>
          ${d.entries.map((x) => `<div class="entry ${x.is_winner ? 'win' : ''}"><div class="row between"><b>${x.is_winner ? '🏆 ' : ''}${esc(x.nickname)} ${stageTag(x.child_stage)}</b><span class="small muted">${ago(x.created_at)}</span></div><p>${esc(x.content)}</p></div>`).join('') || '<div class="empty small">첫 번째 참여자가 되어보세요!</div>'}
        </section>
      </div>`;
    const ef = document.getElementById('ef');
    if (ef) onSubmit(ef, async (data) => {
      const r = await api(`/events/${e.id}/entries`, { body: data });
      toast(r.earned ? `참여 완료! +${fmt(r.earned)}P 🎉` : '참여 완료!');
      await refreshMe();
      route();
    });
    document.getElementById('share').addEventListener('click', () => {
      const url = state.user ? `${location.origin}/#/event/${e.id}?ref=${state.user.referralCode}` : `${location.origin}/#/event/${e.id}`;
      share({ title: e.title, text: `${e.emoji} ${e.title} - 참여만 해도 포인트 적립! [${state.config.siteName}]`, url });
    });
    document.getElementById('draw')?.addEventListener('click', async () => {
      if (!confirm(`참여자 중 ${e.winners_count}명을 무작위 추첨하고 이벤트를 마감할까요?`)) return;
      try { const r = await api(`/admin/events/${e.id}/draw`, { body: {} }); toast(`${r.winners}명 당첨 처리 완료`); route(); } catch (err) { toast(err.message); }
    });
  };

  pages.shop = async () => {
    const { products } = await api('/products');
    const u = state.user;
    const w = state.config.withdrawal;
    $app.innerHTML = `
      <div class="page-head"><div><h1>🎁 포인트샵</h1><p>모은 포인트로 기프티콘·육아용품을 교환하거나 현금으로 출금하세요.</p></div></div>
      <div class="balance-banner">
        <div><div class="small">내 보유 포인트</div><div class="bal">${u ? `${fmt(u.points)}P` : '로그인 후 확인'}</div></div>
        <div class="row">
          <a class="btn" href="${u ? '#/withdraw' : '#/login?next=/withdraw'}">💸 현금 출금 (${fmt(w.minimum)}P~)</a>
          <a class="btn" style="background:rgba(255,255,255,.2);color:#fff" href="#/guide">포인트 모으는 법</a>
        </div>
      </div>
      <div class="product-grid">${products.map((p) => `
        <div class="product">
          <div class="thumb">${esc(p.emoji)}</div>
          <div class="info">
            <span class="badge" style="justify-self:start">${esc(p.category)}</span>
            <b>${esc(p.name)}</b>
            <span class="small muted">${esc(p.description)}</span>
            <div class="row between"><span class="price">${fmt(p.price)}P</span><span class="small muted">${p.stock > 0 ? `재고 ${fmt(p.stock)}` : '품절'}</span></div>
            <button class="btn" data-buy="${p.id}" ${p.stock > 0 ? '' : 'disabled'}>${p.stock > 0 ? '교환하기' : '품절'}</button>
          </div>
        </div>`).join('')}</div>`;

    $app.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => {
      if (!requireLogin()) return;
      const p = products.find((x) => x.id === Number(b.dataset.buy));
      const lack = p.price - state.user.points;
      openModal(`
        <h3>${esc(p.emoji)} ${esc(p.name)}</h3>
        <p class="small muted" style="margin-top:-6px">${fmt(p.price)}P 차감 · 보유 ${fmt(state.user.points)}P</p>
        ${lack > 0 ? `<div class="notice-box">포인트가 ${fmt(lack)}P 부족해요. 출석·글쓰기·이벤트로 포인트를 모아보세요!</div><button class="btn ghost block" data-close style="margin-top:12px">닫기</button>` : `
        <form class="form" id="of">
          <div class="field"><label>받는 분 이름</label><input class="input" name="recipient" required /></div>
          <div class="field"><label>휴대폰 번호</label><input class="input" name="phone" required placeholder="010-0000-0000" inputmode="tel" /><span class="hint">${p.needs_address ? '배송 안내 문자를 보내드려요.' : '기프티콘이 이 번호로 발송돼요.'}</span></div>
          ${p.needs_address ? '<div class="field"><label>배송 주소</label><input class="input" name="address" required placeholder="도로명 주소와 상세주소" /></div>' : ''}
          <div class="row"><button type="button" class="btn ghost" data-close style="flex:1">취소</button><button class="btn" type="submit" style="flex:2">${fmt(p.price)}P로 교환</button></div>
        </form>`}`,
      (box) => {
        const of = box.querySelector('#of');
        if (of) onSubmit(of, async (data) => {
          await api('/orders', { body: { ...data, productId: p.id } });
          closeModal();
          toast('교환 신청 완료! 영업일 기준 1~3일 내 발송돼요.');
          await refreshMe();
          route();
        });
      });
    }));
  };

  pages.withdraw = async () => {
    if (!requireLogin()) return;
    await refreshMe();
    const w = state.config.withdrawal;
    const u = state.user;
    const { withdrawals } = await api('/me/withdrawals');
    const maxAmount = Math.floor(u.points / 1000) * 1000;
    const statusLabel = { pending: '<span class="badge wait">처리 대기</span>', paid: '<span class="badge ok">입금 완료</span>', rejected: '<span class="badge no">반려</span>' };
    $app.innerHTML = `
      <div class="mid">
        <div class="page-head"><div><h1>💸 현금 출금</h1><p>${w.pointToWon}P = ${w.pointToWon}원 · ${fmt(w.minimum)}P부터 1,000P 단위 출금</p></div></div>
        <div class="balance-banner"><div><div class="small">출금 가능 포인트</div><div class="bal">${fmt(u.points)}P</div></div></div>
        <form class="card form" id="wf">
          <div class="field"><label>출금 포인트</label>
            <input class="input" type="number" name="amount" min="${w.minimum}" step="1000" max="${maxAmount}" required placeholder="${fmt(w.minimum)} 이상" />
            <span class="hint" id="payout">수수료 ${fmt(w.fee)}P 차감 후 입금됩니다.</span></div>
          <div class="grid2">
            <div class="field"><label>은행</label><select class="input" name="bank" required><option value="">선택</option>${state.config.banks.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
            <div class="field"><label>예금주</label><input class="input" name="accountHolder" required placeholder="본인 명의만 가능" /></div>
          </div>
          <div class="field"><label>계좌번호</label><input class="input" name="accountNumber" required inputmode="numeric" placeholder="- 없이 숫자만" /></div>
          <div class="notice-box"><b>출금 안내</b><ul>
            <li>가입 후 ${w.minAccountAgeDays}일이 지난 회원만 출금할 수 있어요.</li>
            <li>출금 신청은 하루 1회, 처리 대기 중인 신청이 있으면 추가 신청이 불가해요.</li>
            <li>운영팀 확인 후 영업일 기준 3~5일 내 입금되며, 반려 시 포인트는 전액 환불됩니다.</li>
            <li>부정 적립(다중 계정, 도배 등)이 확인되면 출금이 거절되고 포인트가 회수될 수 있어요.</li>
            <li>관련 법령에 따라 일정 금액 이상 출금 시 본인 확인 및 세금이 원천징수될 수 있어요.</li>
          </ul></div>
          <button class="btn block" type="submit" ${u.points < w.minimum ? 'disabled' : ''}>${u.points < w.minimum ? `${fmt(w.minimum - u.points)}P 더 모으면 출금할 수 있어요` : '출금 신청하기'}</button>
        </form>
        <section class="card">
          <div class="card-title"><h3>출금 내역</h3></div>
          ${withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>신청일</th><th>계좌</th><th class="num">차감</th><th class="num">입금액</th><th>상태</th></tr></thead><tbody>
            ${withdrawals.map((x) => `<tr><td>${dt(x.created_at)}</td><td>${esc(x.bank)} ****${esc(x.account_number.slice(-4))}</td><td class="num">${fmt(x.amount)}P</td><td class="num">${fmt(x.payout)}원</td><td>${statusLabel[x.status] || esc(x.status)}${x.admin_memo ? `<div class="small muted">${esc(x.admin_memo)}</div>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty small">출금 내역이 없어요.</div>'}
        </section>
      </div>`;
    const form = document.getElementById('wf');
    form.amount.addEventListener('input', () => {
      const a = Number(form.amount.value) || 0;
      document.getElementById('payout').textContent = a >= w.minimum ? `실 입금액: ${fmt((a - w.fee) * w.pointToWon)}원 (수수료 ${fmt(w.fee)}P)` : `수수료 ${fmt(w.fee)}P 차감 후 입금됩니다.`;
    });
    onSubmit(form, async (data) => {
      if (!confirm(`${fmt(data.amount)}P를 출금 신청할까요?`)) return;
      const r = await api('/withdrawals', { body: { ...data, amount: Number(data.amount) } });
      toast(`출금 신청 완료! ${fmt(r.payout)}원이 입금될 예정이에요.`);
      await refreshMe();
      route();
    });
  };

  pages.me = async (params) => {
    if (!requireLogin()) return;
    const tab = params.get('tab') || 'points';
    const [me, pts] = await Promise.all([api('/me'), api(`/me/points?page=${Number(params.get('page')) || 1}`)]);
    state.user = me.user;
    renderUserbox();
    const u = me.user;
    const link = inviteLink(u.referralCode);
    let body = '';
    if (tab === 'points') {
      const { items } = pts;
      body = items.length ? `<div class="table-wrap"><table><thead><tr><th>일시</th><th>내용</th><th class="num">포인트</th><th class="num">잔액</th></tr></thead><tbody>
        ${items.map((t) => `<tr><td class="small">${dt(t.created_at)}</td><td>${esc(t.description)}</td><td class="num ${t.amount > 0 ? 'plus' : 'minus'}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</td><td class="num">${fmt(t.balance)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">포인트 내역이 없어요.</div>';
    } else if (tab === 'orders') {
      const { orders } = await api('/me/orders');
      const st = { requested: '<span class="badge wait">준비중</span>', sent: '<span class="badge ok">발송완료</span>', canceled: '<span class="badge no">취소</span>' };
      body = orders.length ? `<div class="table-wrap"><table><thead><tr><th>신청일</th><th>상품</th><th class="num">포인트</th><th>상태</th></tr></thead><tbody>
        ${orders.map((o) => `<tr><td class="small">${dt(o.created_at)}</td><td>${esc(o.emoji)} ${esc(o.name)}</td><td class="num">${fmt(o.price)}P</td><td>${st[o.status] || esc(o.status)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">교환 내역이 없어요. <a href="#/shop"><b>포인트샵 둘러보기 →</b></a></div>';
    } else if (tab === 'friends') {
      const { list } = await api('/me/referrals');
      body = list.length ? `<ul class="rank">${list.map((f, i) => `<li><span class="no">${i + 1}</span><span class="nm">${esc(f.nickname)}</span><span class="small muted">${dt(f.created_at)} 가입</span></li>`).join('')}</ul>` : '<div class="empty">아직 초대한 친구가 없어요. 초대 링크를 공유해 보세요!</div>';
    }
    const tabs = [['points', '포인트 내역'], ['orders', '교환 내역'], ['friends', `초대한 친구 (${me.referrals})`]];
    $app.innerHTML = `
      <div class="page-head"><div><h1>👤 ${esc(u.nickname)}님</h1><p>${esc(u.email)} ${u.childStage ? `· ${esc(u.childStage)}` : ''} ${u.region ? `· ${esc(u.region)}` : ''}</p></div>
        <div class="row">${u.role === 'admin' ? '<a class="btn soft" href="#/admin">관리자 페이지</a>' : ''}<button class="btn ghost" id="logout">로그아웃</button></div></div>
      <div class="stat-grid">
        <div class="stat"><span>보유 포인트</span><b style="color:var(--primary-dark)">${fmt(u.points)}P</b></div>
        <div class="stat"><span>누적 적립</span><b>${fmt(pts.earned)}P</b></div>
        <div class="stat"><span>사용/출금</span><b>${fmt(pts.spent)}P</b></div>
        <div class="stat"><span>연속 출석</span><b>${fmt(u.attendanceStreak)}일</b></div>
      </div>
      <div class="layout">
        <section class="card">
          <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/me?tab=${k}">${l}</a>`).join('')}</div>
          ${body}
          ${tab === 'points' ? `<div class="pager"><button data-pp="-1">이전</button><button data-pp="1">다음</button></div>` : ''}
        </section>
        <aside class="stack">
          <section class="card invite">
            <div class="card-title"><h3>💌 내 초대 코드</h3></div>
            <div class="code">${esc(u.referralCode)}</div>
            <p class="small">친구가 가입하면 나 <b>+${fmt(state.config.points.referrer)}P</b>, 친구 <b>+${fmt(state.config.points.referee)}P</b></p>
            <div class="copybox"><input class="input" readonly value="${esc(link)}" id="invlink" /><button class="btn sm" id="copy">복사</button></div>
            <button class="btn block" style="margin-top:10px;background:var(--purple)" id="share">카톡·SNS로 공유하기</button>
          </section>
          <section class="card stack">
            <a class="btn block" href="#/withdraw">💸 현금 출금 신청</a>
            <a class="btn block soft" href="#/shop">🎁 상품 교환하기</a>
          </section>
        </aside>
      </div>`;
    document.getElementById('logout').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* 무시 */ }
      setSession(null, null);
      toast('로그아웃 되었어요.');
      location.hash = '#/';
    });
    document.getElementById('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('초대 링크가 복사됐어요!'); } catch (_) { document.getElementById('invlink').select(); }
    });
    document.getElementById('share').addEventListener('click', () =>
      share({ title: state.config.siteName, text: `육아하는 엄마·아빠 커뮤니티 ${state.config.siteName}! 내 초대코드 ${u.referralCode}로 가입하면 보너스 포인트 🎁`, url: link }));
    $app.querySelectorAll('[data-pp]').forEach((b) => b.addEventListener('click', () => {
      const page = Math.max(1, (Number(params.get('page')) || 1) + Number(b.dataset.pp));
      location.hash = `#/me?tab=points&page=${page}`;
    }));
  };

  pages.guide = async () => {
    const p = state.config.points;
    const w = state.config.withdrawal;
    const rules = [
      ['🎁', '회원가입', `+${fmt(p.signup)}P`, '가입 즉시 지급'],
      ['💌', '친구 초대', `+${fmt(p.referrer)}P`, `초대받은 친구도 +${fmt(p.referee)}P`],
      ['📅', '매일 출석체크', `+${fmt(p.attendance)}P`, `7일 연속 출석 시 +${fmt(p.attendanceStreak7)}P 보너스`],
      ['✏️', '게시글 작성', `+${fmt(p.post.points)}P`, `하루 최대 ${p.post.dailyLimit}회`],
      ['💬', '댓글 작성', `+${fmt(p.comment.points)}P`, `하루 최대 ${p.comment.dailyLimit}회`],
      ['♥', '내 글 공감 받기', `+${fmt(p.likeReceived.points)}P`, `하루 최대 ${p.likeReceived.dailyLimit}회`],
      ['🎉', '매주 이벤트 참여', `+${fmt(p.eventEntry)}P`, '매주 월요일 새 이벤트 오픈'],
      ['🏆', '이벤트 당첨', `+${fmt(p.weeklyPrize)}P`, `매주 ${p.weeklyWinners}명 추첨`],
    ];
    $app.innerHTML = `
      <div class="page-head"><div><h1>💰 포인트 제도 안내</h1><p>활동할수록 쌓이는 포인트, 육아용품과 현금으로 돌려받으세요.</p></div></div>
      <section class="card">
        <div class="card-title"><h2>포인트 적립 방법</h2></div>
        <div class="rule-grid">${rules.map(([i, t, pts, s]) => `<div class="rule"><span class="ico">${i}</span><b>${t}</b><div class="pts">${pts}</div><div class="small muted">${s}</div></div>`).join('')}</div>
      </section>
      <div class="grid2" style="margin-top:16px">
        <section class="card">
          <div class="card-title"><h2>🎁 상품 교환</h2></div>
          <ol class="steps">
            <li>포인트샵에서 원하는 기프티콘·육아용품 선택</li>
            <li>받는 분 정보 입력 후 포인트로 교환</li>
            <li>영업일 기준 1~3일 내 문자/택배로 발송</li>
          </ol>
          <a class="btn soft block" style="margin-top:14px" href="#/shop">포인트샵 가기</a>
        </section>
        <section class="card">
          <div class="card-title"><h2>💸 현금 출금</h2></div>
          <ol class="steps">
            <li>${fmt(w.minimum)}P 이상 모으기 (1P = ${w.pointToWon}원)</li>
            <li>본인 명의 계좌로 출금 신청 (수수료 ${fmt(w.fee)}P)</li>
            <li>운영팀 확인 후 영업일 3~5일 내 입금</li>
          </ol>
          <a class="btn mint block" style="margin-top:14px" href="#/withdraw">출금 신청하기</a>
        </section>
      </div>
      <section class="card" style="margin-top:16px">
        <div class="card-title"><h2>⚠️ 공정한 커뮤니티를 위한 약속</h2></div>
        <ul class="small" style="margin:0;padding-left:18px">
          <li>도배·복사 글, 의미 없는 댓글은 삭제되고 적립 포인트가 회수될 수 있어요.</li>
          <li>1인 다계정, 자기 추천 등 부정 적립은 영구 이용 제한 및 출금 거절 대상이에요.</li>
          <li>포인트 정책은 운영 상황에 따라 공지 후 변경될 수 있어요.</li>
        </ul>
      </section>`;
  };

  pages.login = async (params) => {
    const next = params.get('next') || '/';
    $app.innerHTML = `
      <div class="narrow">
        <div class="page-head"><div><h1>👋 다시 오셨네요!</h1><p>오늘도 출석체크 잊지 마세요.</p></div></div>
        <form class="card form" id="lf">
          <div class="field"><label>이메일</label><input class="input" type="email" name="email" required autocomplete="email" /></div>
          <div class="field"><label>비밀번호</label><input class="input" type="password" name="password" required autocomplete="current-password" /></div>
          <button class="btn block" type="submit">로그인</button>
          <p class="small muted" style="text-align:center;margin:0">아직 회원이 아니신가요? <a href="#/signup"><b>가입하고 ${fmt(state.config.points.signup)}P 받기</b></a></p>
        </form>
      </div>`;
    onSubmit(document.getElementById('lf'), async (data) => {
      const r = await api('/auth/login', { body: data });
      setSession(r.token, r.user);
      toast(`${r.user.nickname}님 환영해요!`);
      location.hash = `#${next.startsWith('/') ? next : '/'}`;
    });
  };

  pages.signup = async (params) => {
    let ref = params.get('ref') || '';
    try { ref = ref || sessionStorage.getItem('ref') || ''; } catch (_) { /* 무시 */ }
    const p = state.config.points;
    $app.innerHTML = `
      <div class="narrow">
        <div class="page-head"><div><h1>🍼 회원가입</h1><p>가입 즉시 <b>${fmt(p.signup)}P</b>${ref ? `, 초대 코드 입력 시 <b>+${fmt(p.referee)}P</b> 추가` : ''}!</p></div></div>
        <form class="card form" id="sf">
          <div class="field"><label>이메일</label><input class="input" type="email" name="email" required autocomplete="email" /></div>
          <div class="field"><label>비밀번호</label><input class="input" type="password" name="password" required minlength="8" autocomplete="new-password" /><span class="hint">8자 이상</span></div>
          <div class="field"><label>닉네임</label><input class="input" name="nickname" required minlength="2" maxlength="12" placeholder="예) 쌍둥이아빠, 봄이맘" /></div>
          <div class="grid2">
            <div class="field"><label>아이 연령대</label><select class="input" name="childStage"><option value="">선택 안 함</option>${state.config.childStages.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
            <div class="field"><label>지역</label><input class="input" name="region" maxlength="20" placeholder="예) 서울 마포구" /></div>
          </div>
          <div class="field"><label>초대 코드 (선택)</label><input class="input" name="referralCode" value="${esc(ref)}" placeholder="친구에게 받은 코드" style="text-transform:uppercase" /></div>
          <label class="small row" style="gap:6px"><input type="checkbox" required /> 이용약관 및 개인정보 수집·이용에 동의합니다. (필수)</label>
          <button class="btn block" type="submit">가입하고 포인트 받기</button>
          <p class="small muted" style="text-align:center;margin:0">이미 회원이신가요? <a href="#/login"><b>로그인</b></a></p>
        </form>
      </div>`;
    onSubmit(document.getElementById('sf'), async (data) => {
      const r = await api('/auth/signup', { body: data });
      setSession(r.token, r.user);
      try { sessionStorage.removeItem('ref'); } catch (_) { /* 무시 */ }
      toast(`가입 완료! ${fmt(r.user.points)}P가 적립됐어요 🎉`);
      location.hash = '#/';
    });
  };

  // ── 관리자 ─────────────────────────────────────────────
  pages.admin = async (params) => {
    if (!requireLogin()) return;
    if (state.user.role !== 'admin') { $app.innerHTML = '<div class="empty">관리자만 접근할 수 있어요.</div>'; return; }
    const tab = params.get('tab') || 'dash';
    const tabs = [['dash', '대시보드'], ['withdrawals', '출금 관리'], ['orders', '교환 관리'], ['products', '상품 관리'], ['events', '이벤트 관리'], ['users', '회원 관리']];
    let body = '';
    let bind = () => {};

    if (tab === 'dash') {
      const s = await api('/admin/stats');
      body = `<div class="stat-grid">
        <div class="stat"><span>전체 회원</span><b>${fmt(s.members)}</b></div>
        <div class="stat"><span>오늘 가입</span><b>${fmt(s.todaySignups)}</b></div>
        <div class="stat"><span>게시글</span><b>${fmt(s.posts)}</b></div>
        <div class="stat"><span>회원 보유 포인트 (부채)</span><b>${fmt(s.pointsOutstanding)}P</b></div>
        <div class="stat"><span>출금 대기</span><b style="color:var(--danger)">${fmt(s.pendingWithdrawals.c)}건 / ${fmt(s.pendingWithdrawals.s)}원</b></div>
        <div class="stat"><span>교환 대기</span><b>${fmt(s.pendingOrders)}건</b></div>
        <div class="stat"><span>누적 현금 지급</span><b>${fmt(s.paidTotal)}원</b></div>
      </div>
      <div class="notice-box">회원 보유 포인트는 언제든 출금될 수 있는 잠재 비용이에요. 포인트 정책(config.js)과 예산을 함께 관리하세요.</div>`;
    } else if (tab === 'withdrawals') {
      const status = params.get('status') || 'pending';
      const { withdrawals } = await api(`/admin/withdrawals?status=${status}`);
      body = `<div class="tabs">${[['pending', '대기'], ['paid', '지급완료'], ['rejected', '반려']].map(([k, l]) => `<a class="tab ${k === status ? 'active' : ''}" href="#/admin?tab=withdrawals&status=${k}">${l}</a>`).join('')}</div>
        ${withdrawals.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>신청일</th><th>회원</th><th>계좌</th><th class="num">차감P</th><th class="num">입금액</th><th></th></tr></thead><tbody>
        ${withdrawals.map((w) => `<tr><td>${w.id}</td><td class="small">${dt(w.created_at)}</td><td>${esc(w.nickname)}<div class="small muted">${esc(w.email)}</div></td>
          <td>${esc(w.bank)} ${esc(w.account_number)}<div class="small muted">예금주 ${esc(w.account_holder)}</div></td>
          <td class="num">${fmt(w.amount)}</td><td class="num"><b>${fmt(w.payout)}원</b></td>
          <td>${w.status === 'pending' ? `<div class="row"><button class="btn mint sm" data-wd="${w.id}" data-act="paid">입금완료</button><button class="btn ghost sm" data-wd="${w.id}" data-act="rejected">반려</button></div>` : `<span class="small muted">${esc(w.admin_memo || '')}</span>`}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">내역이 없어요.</div>'}
        <p class="small muted">※ 실제 송금은 은행/펌뱅킹으로 진행한 뒤 '입금완료'를 눌러주세요. 반려 시 포인트가 자동 환불됩니다.</p>`;
      bind = () => $app.querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', async () => {
        const act = b.dataset.act;
        const memo = act === 'rejected' ? prompt('반려 사유를 입력해 주세요 (회원에게 표시됨)') : prompt('메모 (선택)', '입금 완료');
        if (memo === null) return;
        try { await api(`/admin/withdrawals/${b.dataset.wd}`, { body: { action: act, memo } }); toast('처리됐어요.'); route(); } catch (err) { toast(err.message); }
      }));
    } else if (tab === 'orders') {
      const { orders } = await api('/admin/orders');
      body = orders.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>신청일</th><th>상품</th><th>회원</th><th>수령 정보</th><th></th></tr></thead><tbody>
        ${orders.map((o) => `<tr><td>${o.id}</td><td class="small">${dt(o.created_at)}</td><td>${esc(o.emoji)} ${esc(o.name)}<div class="small muted">${fmt(o.price)}P</div></td><td>${esc(o.nickname)}</td>
          <td>${esc(o.recipient)} · ${esc(o.phone)}${o.address ? `<div class="small muted">${esc(o.address)}</div>` : ''}</td>
          <td>${o.status === 'requested' ? `<div class="row"><button class="btn mint sm" data-od="${o.id}" data-act="sent">발송완료</button><button class="btn ghost sm" data-od="${o.id}" data-act="canceled">취소·환불</button></div>` : `<span class="badge ${o.status === 'sent' ? 'ok' : 'no'}">${o.status === 'sent' ? '발송완료' : '취소'}</span>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">교환 신청이 없어요.</div>';
      bind = () => $app.querySelectorAll('[data-od]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm(b.dataset.act === 'sent' ? '발송 완료로 처리할까요?' : '주문을 취소하고 포인트를 환불할까요?')) return;
        try { await api(`/admin/orders/${b.dataset.od}`, { body: { action: b.dataset.act } }); toast('처리됐어요.'); route(); } catch (err) { toast(err.message); }
      }));
    } else if (tab === 'products') {
      const { products } = await api('/admin/products');
      body = `<div class="table-wrap"><table><thead><tr><th>상품</th><th class="num">가격</th><th class="num">재고</th><th>상태</th><th></th></tr></thead><tbody>
        ${products.map((p) => `<tr><td>${esc(p.emoji)} ${esc(p.name)}<div class="small muted">${esc(p.category)}</div></td><td class="num">${fmt(p.price)}P</td><td class="num">${fmt(p.stock)}</td><td>${p.active ? '<span class="badge ok">판매중</span>' : '<span class="badge no">숨김</span>'}</td>
          <td><div class="row"><button class="btn ghost sm" data-stock="${p.id}">재고수정</button><button class="btn ghost sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? '숨기기' : '판매재개'}</button></div></td></tr>`).join('')}
      </tbody></table></div>
      <h3 style="margin:20px 0 10px">상품 추가</h3>
      <form class="form" id="pf">
        <div class="grid2"><div class="field"><label>상품명</label><input class="input" name="name" required /></div><div class="field"><label>분류</label><input class="input" name="category" required placeholder="기프티콘 / 육아용품 / 도서" /></div></div>
        <div class="field"><label>설명</label><input class="input" name="description" required /></div>
        <div class="grid2"><div class="field"><label>가격(P)</label><input class="input" type="number" name="price" min="1" required /></div><div class="field"><label>재고</label><input class="input" type="number" name="stock" min="0" required /></div></div>
        <div class="grid2"><div class="field"><label>이모지</label><input class="input" name="emoji" placeholder="🎁" /></div><label class="small row" style="gap:6px;margin-top:24px"><input type="checkbox" name="needsAddress" /> 배송 주소 필요(실물 상품)</label></div>
        <button class="btn" type="submit">상품 추가</button>
      </form>`;
      bind = () => {
        $app.querySelectorAll('[data-stock]').forEach((b) => b.addEventListener('click', async () => {
          const v = prompt('새 재고 수량');
          if (v === null) return;
          try { await api(`/admin/products/${b.dataset.stock}`, { method: 'PATCH', body: { stock: Number(v) } }); route(); } catch (err) { toast(err.message); }
        }));
        $app.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
          try { await api(`/admin/products/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } }); route(); } catch (err) { toast(err.message); }
        }));
        onSubmit(document.getElementById('pf'), async (data) => {
          await api('/admin/products', { body: { ...data, price: Number(data.price), stock: Number(data.stock), needsAddress: !!data.needsAddress } });
          toast('상품이 추가됐어요.');
          route();
        });
      };
    } else if (tab === 'events') {
      const { events } = await api('/events');
      const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      body = `<p class="small muted">정기(매주) 이벤트는 매주 월요일 자동 생성돼요. 마감된 이벤트 상세 화면에서 당첨자 추첨을 진행하세요.</p>
        <div class="table-wrap"><table><thead><tr><th>이벤트</th><th>기간</th><th class="num">참여</th><th>상태</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td><a href="#/event/${e.id}"><b>${esc(e.emoji)} ${esc(e.title)}</b></a><div class="small muted">${e.kind === 'weekly' ? '매주' : '스페셜'}</div></td><td class="small">${esc(e.start_date)} ~ ${esc(e.end_date)}</td><td class="num">${fmt(e.entry_count)}</td><td>${e.status === 'open' ? (e.end_date < today ? '<span class="badge no">추첨 필요</span>' : '<span class="badge ok">진행중</span>') : '<span class="badge">마감</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 style="margin:20px 0 10px">스페셜 이벤트 만들기</h3>
        <form class="form" id="evf">
          <div class="grid2"><div class="field"><label>이벤트명</label><input class="input" name="title" required /></div><div class="field"><label>이모지</label><input class="input" name="emoji" placeholder="🎉" /></div></div>
          <div class="field"><label>설명</label><textarea class="input" name="description" required></textarea></div>
          <div class="grid2"><div class="field"><label>시작일</label><input class="input" type="date" name="startDate" value="${today}" required /></div><div class="field"><label>종료일</label><input class="input" type="date" name="endDate" required /></div></div>
          <div class="grid2"><div class="field"><label>참여 포인트</label><input class="input" type="number" name="participationPoints" value="100" min="0" /></div><div class="field"><label>당첨 포인트</label><input class="input" type="number" name="prizePoints" value="5000" min="0" /></div></div>
          <div class="field"><label>당첨자 수</label><input class="input" type="number" name="winnersCount" value="3" min="1" /></div>
          <button class="btn" type="submit">이벤트 등록</button>
        </form>`;
      bind = () => onSubmit(document.getElementById('evf'), async (data) => {
        const r = await api('/admin/events', { body: { ...data, participationPoints: Number(data.participationPoints), prizePoints: Number(data.prizePoints), winnersCount: Number(data.winnersCount) } });
        toast('이벤트가 등록됐어요.');
        location.hash = `#/event/${r.id}`;
      });
    } else if (tab === 'users') {
      const q = params.get('q') || '';
      const { users } = await api(`/admin/users?q=${encodeURIComponent(q)}`);
      body = `<form class="row" id="uq" style="margin-bottom:12px"><input class="input" name="q" value="${esc(q)}" placeholder="이메일/닉네임 검색" style="max-width:260px" /><button class="btn ghost sm">검색</button></form>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>회원</th><th>정보</th><th class="num">포인트</th><th class="num">초대</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${u.id}</td><td>${esc(u.nickname)} ${u.role === 'admin' ? '<span class="badge no">관리자</span>' : ''}<div class="small muted">${esc(u.email)}</div></td><td class="small">${esc(u.child_stage || '-')} · ${esc(u.region || '-')}<div class="muted">${dt(u.created_at)}</div></td><td class="num">${fmt(u.points)}</td><td class="num">${fmt(u.referrals)}</td><td><button class="btn ghost sm" data-adj="${u.id}" data-nick="${esc(u.nickname)}">포인트 조정</button></td></tr>`).join('')}
        </tbody></table></div>`;
      bind = () => {
        document.getElementById('uq').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/admin?tab=users&q=${encodeURIComponent(e.target.q.value.trim())}`; });
        $app.querySelectorAll('[data-adj]').forEach((b) => b.addEventListener('click', async () => {
          const amount = prompt(`${b.dataset.nick}님 포인트 지급(+) / 회수(-) 금액`);
          if (!amount) return;
          const reason = prompt('사유 (회원 포인트 내역에 표시됨)');
          if (!reason) return;
          try { await api(`/admin/users/${b.dataset.adj}/points`, { body: { amount: Number(amount), reason } }); toast('조정됐어요.'); route(); } catch (err) { toast(err.message); }
        }));
      };
    }

    $app.innerHTML = `
      <div class="page-head"><div><h1>🛠 관리자</h1><p>출금·교환 처리, 상품·이벤트·회원 관리</p></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/admin?tab=${k}">${l}</a>`).join('')}</div>
      <section class="card">${body}</section>`;
    bind();
  };

  // ── 라우터 ─────────────────────────────────────────────
  const routes = [
    [/^\/$/, 'home'], [/^\/board$/, 'board'], [/^\/write$/, 'write'], [/^\/post\/(\d+)$/, 'post'],
    [/^\/events$/, 'events'], [/^\/event\/(\d+)$/, 'event'], [/^\/shop$/, 'shop'], [/^\/withdraw$/, 'withdraw'],
    [/^\/me$/, 'me'], [/^\/guide$/, 'guide'], [/^\/login$/, 'login'], [/^\/signup$/, 'signup'], [/^\/admin$/, 'admin'],
  ];

  let routeSeq = 0;
  async function route() {
    const seq = ++routeSeq;
    const raw = location.hash.slice(1) || '/';
    const [pathPart, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    // 공유 링크의 초대 코드 기억 (가입 시 자동 입력)
    if (params.get('ref')) { try { sessionStorage.setItem('ref', params.get('ref')); } catch (_) { /* 무시 */ } }

    let name = 'home';
    let arg;
    for (const [re, n] of routes) {
      const m = pathPart.match(re);
      if (m) { name = n; arg = m[1]; break; }
    }
    const section = { post: 'board', write: 'board', event: 'events', withdraw: 'shop', admin: 'me' }[name] || name;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    closeModal();
    try {
      if (seq !== routeSeq) return;
      await pages[name](params, arg);
      if (seq === routeSeq) window.scrollTo(0, 0);
    } catch (err) {
      if (seq === routeSeq) $app.innerHTML = `<div class="empty">😢 ${esc(err.message)}<br/><br/><a class="btn soft" href="#/">홈으로</a></div>`;
    }
  }

  async function init() {
    try {
      state.config = await api('/config');
      document.getElementById('site-name').textContent = state.config.siteName;
    } catch (_) {
      $app.innerHTML = '<div class="empty">서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.</div>';
      return;
    }
    await refreshMe();
    renderUserbox();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();

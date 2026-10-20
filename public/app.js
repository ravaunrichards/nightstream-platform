'use strict';

const state = {
  token: sessionStorage.getItem('nightstream-token') || '',
  user: null,
  categories: ['Amateur', 'Artistic', 'Couples', 'Educational', 'Lifestyle', 'Interviews', 'Other'],
  query: '',
  category: '',
  limit: 24,
  offset: 0,
  currentVideo: null,
  authMode: 'login',
  latest: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const dateLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently published';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
};
const api = async (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = data && typeof data === 'object' ? data.error || data.message : data;
    const error = new Error(message || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
};

function toast(message, type = 'success') {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', type === 'error');
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 4000);
}

function setFormMessage(selector, message, isError = false, linkUrl = '') {
  const element = $(selector);
  element.replaceChildren();
  element.classList.toggle('error', isError);
  if (linkUrl) {
    element.append(document.createTextNode(`${message} `));
    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = 'Verify email';
    link.rel = 'noreferrer';
    element.append(link);
  } else {
    element.textContent = message || '';
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const focusTarget = $('input:not([type=hidden]),button,textarea,select', modal);
  if (focusTarget) setTimeout(() => focusTarget.focus(), 25);
}
function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('hidden');
  if ($$('.modal:not(.hidden)').length === 0) document.body.style.overflow = '';
  if (id === 'player-modal') {
    const player = $('#video-player');
    player.pause();
    player.removeAttribute('src');
    player.load();
    state.currentVideo = null;
  }
}

function openAuth(mode = 'login') {
  state.authMode = mode;
  renderAuthForm();
  openModal('auth-modal');
}

function renderAuthForm() {
  const register = state.authMode === 'register';
  $('#auth-title').textContent = register ? 'Create your account' : 'Welcome back';
  $$('#auth-tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.authMode === state.authMode));
  $('#auth-form').innerHTML = `${register ? `
    <label>Username <input name="username" type="text" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" autocomplete="username" required placeholder="Your public handle"><small>3–24 letters, numbers, or underscores.</small></label>
    <label>Date of birth <input name="dateOfBirth" type="date" required autocomplete="bday"><small>Accounts are restricted to adults aged 18 or older.</small></label>` : ''}
    <label>Email <input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label>
    <label>Password <input name="password" type="password" required minlength="12" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="${register ? 'At least 12 characters' : 'Your password'}"></label>
    ${register ? `<div class="attestation-box"><label class="check-label"><input name="ageAttestation" type="checkbox" value="yes" required><span>I am at least 18 years old and the date of birth I entered is accurate.</span></label><label class="check-label"><input name="termsAccepted" type="checkbox" value="yes" required><span>I accept the platform terms and the adult-only safety rules.</span></label></div>` : ''}
    <button class="button button-primary button-wide" type="submit">${register ? 'Create account' : 'Sign in'}</button>`;
  setFormMessage('#auth-message', '');
}

function renderCurrentUser() {
  const accountButton = $('#account-button');
  const modNav = $('#moderation-nav');
  if (state.user) {
    accountButton.textContent = 'Sign out';
    modNav.classList.toggle('hidden', !['moderator', 'admin'].includes(state.user.role));
    const status = state.user.ageAssuranceStatus === 'verified' ? 'Age assurance: verified' : 'Age assurance: pending';
    $('#readiness-message').textContent = `${state.user.emailVerified ? 'Email: verified' : 'Email: not verified'} · ${status}. Creator uploads remain locked until all required checks are complete.`;
  } else {
    accountButton.textContent = 'Sign in';
    modNav.classList.add('hidden');
    $('#readiness-message').textContent = 'Sign in to see your account status.';
  }
}

async function refreshUser() {
  if (!state.token) {
    state.user = null;
    renderCurrentUser();
    return;
  }
  try {
    const data = await api('/api/me');
    state.user = data.user;
  } catch {
    state.user = null;
    state.token = '';
    sessionStorage.removeItem('nightstream-token');
  }
  renderCurrentUser();
}

function renderChips() {
  const chips = $('#category-chips');
  chips.innerHTML = `<button class="chip ${state.category === '' ? 'selected' : ''}" data-category="">All categories</button>${state.categories.map((name) => `<button class="chip ${state.category === name ? 'selected' : ''}" data-category="${escapeHTML(name)}">${escapeHTML(name)}</button>`).join('')}`;
  chips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    state.offset = 0;
    renderChips();
    loadVideos();
  }, { once: true });
}

const categoryDescriptions = {
  Amateur: 'Independent creator-led videos.',
  Artistic: 'Creative direction and visual storytelling.',
  Couples: 'Content from consenting adult couples.',
  Educational: 'Informational and discussion-led videos.',
  Lifestyle: 'People, routines, and personal expression.',
  Interviews: 'Conversations and creator perspectives.',
  Other: 'More from across the reviewed library.'
};
function renderCategoryCards() {
  $('#category-grid').innerHTML = state.categories.map((name, index) => `
    <button class="category-card" data-category-card="${escapeHTML(name)}"><span class="category-number">CATEGORY / ${String(index + 1).padStart(2, '0')}</span><span class="category-arrow">↗</span><h3>${escapeHTML(name)}</h3><p>${escapeHTML(categoryDescriptions[name] || '')}</p></button>`).join('');
}

function videoCard(video) {
  return `<article class="video-card">
    <button class="video-thumb" type="button" data-play-video="${escapeHTML(video.id)}" aria-label="Play ${escapeHTML(video.title)}"><span class="thumb-shape" aria-hidden="true"></span><span class="video-play" aria-hidden="true">▶</span></button>
    <div class="video-info"><h3 class="video-title">${escapeHTML(video.title)}</h3><p class="video-subtitle">by ${escapeHTML(video.creator || 'Creator')}</p><div class="video-badges"><span class="category-badge">${escapeHTML(video.category)}</span><span class="date-badge">${escapeHTML(dateLabel(video.created_at))}</span></div></div>
  </article>`;
}
function emptyState(title, description) {
  return `<div class="empty-state"><div class="empty-symbol">◈</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p></div>`;
}
function errorState(message) {
  return `<div class="error-state"><div class="empty-symbol">!</div><h3>Library unavailable</h3><p>${escapeHTML(message)}</p><button class="button button-outline" data-retry-videos>Try again</button></div>`;
}

async function loadVideos(options = {}) {
  const append = options.append === true;
  state.offset = append ? state.offset : 0;
  const target = state.latest ? '#latest-grid' : '#video-grid';
  if (!append) $(target).innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading reviewed videos…</div>';
  try {
    const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
    if (state.query) params.set('q', state.query);
    if (state.category) params.set('category', state.category);
    const data = await api(`/api/videos?${params.toString()}`);
    const cards = data.videos.map(videoCard).join('');
    if (append) $(target).insertAdjacentHTML('beforeend', cards);
    else $(target).innerHTML = cards || emptyState(
      state.query || state.category ? 'No matching videos yet' : 'The library is ready for its first release',
      state.query || state.category
        ? 'Try another search or category. New submissions only appear after moderation approval.'
        : 'No reviewed videos have been published yet. Creator submissions stay private until approved; the platform does not invent sample uploads or popularity counts.'
    );
    if (target === '#video-grid') $('#result-count').textContent = `${data.videos.length}${data.videos.length === state.limit ? '+' : ''} video${data.videos.length === 1 ? '' : 's'}`;
    $('#pagination').classList.toggle('hidden', data.videos.length < state.limit);
    $('#load-more').disabled = data.videos.length < state.limit;
    if (append && data.videos.length === 0) $('#pagination').classList.add('hidden');
    state.offset = data.videos.length + (append ? state.offset : 0);
  } catch (error) {
    $(target).innerHTML = errorState(error.message || 'Check the API and database connection.');
    if (target === '#video-grid') $('#result-count').textContent = 'Not connected';
    $('#pagination').classList.add('hidden');
  }
}

function showView(name) {
  const target = $(`#view-${name}`);
  if (!target) return;
  $$('.view').forEach((view) => view.classList.toggle('active-view', view === target));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  $('#sidebar').classList.remove('mobile-open');
  if (name === 'latest') {
    state.latest = true;
    loadVideos();
  } else if (name === 'discover') {
    state.latest = false;
    loadVideos();
  } else if (name === 'categories') renderCategoryCards();
  else if (name === 'library') loadLibrary();
  else if (name === 'moderation') loadModeration();
  else if (name === 'studio') refreshUser();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function openVideo(id) {
  try {
    const data = await api(`/api/videos/${encodeURIComponent(id)}`);
    state.currentVideo = data.video;
    $('#player-category').textContent = data.video.category;
    $('#player-title').textContent = data.video.title;
    $('#player-creator').textContent = `by ${data.video.creator || 'Creator'} · ${dateLabel(data.video.created_at)}`;
    $('#player-description').textContent = data.video.description || 'No description provided.';
    $('#video-player').src = `/api/videos/${encodeURIComponent(data.video.id)}/stream`;
    openModal('player-modal');
  } catch (error) {
    toast(error.message || 'Unable to open this video.', 'error');
  }
}

function openUpload() {
  if (!state.user) {
    openAuth('login');
    setFormMessage('#auth-message', 'Sign in before submitting a video.');
    return;
  }
  $('#upload-form').reset();
  setFormMessage('#upload-message', '');
  openModal('upload-modal');
}

async function loadLibrary() {
  const area = $('#my-videos');
  if (!state.user) {
    area.innerHTML = `<div class="empty-state"><div class="empty-symbol">▤</div><h3>Sign in to view uploads</h3><p>Your submissions and their review statuses will appear here.</p><button id="library-sign-in" class="button button-primary">Sign in</button></div>`;
    $('#library-sign-in').addEventListener('click', () => openAuth('login'));
    return;
  }
  area.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading submissions…</div>';
  try {
    const data = await api('/api/me/videos');
    if (!data.videos.length) {
      area.innerHTML = `<div class="empty-state"><div class="empty-symbol">▤</div><h3>No submissions yet</h3><p>When you submit a video, its review status will appear here.</p><button id="library-upload" class="button button-primary">Submit a video</button></div>`;
      $('#library-upload').addEventListener('click', openUpload);
      return;
    }
    area.innerHTML = `<table class="data-table"><thead><tr><th>Video</th><th>Category</th><th>Status</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${data.videos.map((video) => `<tr><td>${escapeHTML(video.title)}${video.moderation_note ? `<div class="muted">Review note: ${escapeHTML(video.moderation_note)}</div>` : ''}</td><td>${escapeHTML(video.category)}</td><td><span class="status ${escapeHTML(video.status)}">${escapeHTML(video.status.replaceAll('_', ' '))}</span></td><td>${escapeHTML(dateLabel(video.created_at))}</td><td>${video.status === 'removed' ? '—' : `<button class="row-action" data-remove-video="${escapeHTML(video.id)}">Remove</button>`}</td></tr>`).join('')}</tbody></table>`;
  } catch (error) {
    area.innerHTML = errorState(error.message);
  }
}

async function loadModeration() {
  if (!state.user || !['moderator', 'admin'].includes(state.user.role)) {
    $('#moderation-videos').innerHTML = emptyState('Moderator access required', 'Sign in with an approved moderator account.');
    $('#moderation-reports').innerHTML = '';
    return;
  }
  $('#moderation-videos').innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading queue…</div>';
  $('#moderation-reports').innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading reports…</div>';
  try {
    const [videos, reports] = await Promise.all([api('/api/moderation/videos'), api('/api/moderation/reports')]);
    $('#moderation-videos').innerHTML = videos.videos.length ? videos.videos.map((video) => `<article class="moderation-item"><h3>${escapeHTML(video.title)}</h3><p>${escapeHTML(video.creator)} · ${escapeHTML(video.category)} · ${Math.ceil(Number(video.file_size_bytes) / 1_048_576)} MB</p><p>${escapeHTML(video.description || 'No description')}</p><div class="moderation-actions"><button class="row-action" data-review-video="${escapeHTML(video.id)}" data-review-action="publish">Approve</button><button class="row-action" data-review-video="${escapeHTML(video.id)}" data-review-action="reject">Reject</button><button class="row-action" data-review-video="${escapeHTML(video.id)}" data-review-action="remove">Remove</button></div></article>`).join('') : emptyState('Queue is clear', 'There are no videos awaiting review.');
    $('#moderation-reports').innerHTML = reports.reports.length ? reports.reports.map((report) => `<article class="moderation-item"><h3>${escapeHTML(report.category.replaceAll('-', ' '))}</h3><p>${escapeHTML(report.video_title || 'General platform report')} · ${escapeHTML(dateLabel(report.created_at))}</p><p>${escapeHTML(report.details)}</p><div class="moderation-actions"><button class="row-action" data-report-status="investigating" data-report-id="${escapeHTML(report.id)}">Investigating</button><button class="row-action" data-report-status="actioned" data-report-id="${escapeHTML(report.id)}">Actioned</button><button class="row-action" data-report-status="closed" data-report-id="${escapeHTML(report.id)}">Close</button></div></article>`).join('') : emptyState('No open reports', 'No reports are currently marked open.');
  } catch (error) {
    $('#moderation-videos').innerHTML = errorState(error.message);
    $('#moderation-reports').innerHTML = '';
  }
}

function openReport(videoId = '') {
  $('#report-form').reset();
  $('#report-form [name="videoId"]').value = videoId || '';
  setFormMessage('#report-message', '');
  openModal('report-modal');
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const register = state.authMode === 'register';
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  setFormMessage('#auth-message', register ? 'Creating account…' : 'Signing in…');
  try {
    const data = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    if (register) {
      setFormMessage('#auth-message', data.message || 'Account created.', false, data.developmentVerificationUrl || '');
      if (data.developmentVerificationUrl) {
        const message = $('#auth-message');
        const note = document.createElement('div');
        note.className = 'small muted';
        note.textContent = 'Development only: the API also logs this link to the server console. Production uses configured SMTP.';
        message.append(note);
      }
    } else {
      state.token = data.token;
      state.user = data.user;
      sessionStorage.setItem('nightstream-token', data.token);
      renderCurrentUser();
      closeModal('auth-modal');
      toast(`Signed in as ${state.user.username}.`);
      if (state.user.role === 'moderator' || state.user.role === 'admin') $('#moderation-nav').classList.remove('hidden');
      loadLibrary();
    }
  } catch (error) {
    setFormMessage('#auth-message', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function handleUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  setFormMessage('#upload-message', 'Uploading securely to this server…');
  try {
    const data = await api('/api/videos/upload', { method: 'POST', body: new FormData(form) });
    setFormMessage('#upload-message', data.message || 'Submitted for review.');
    toast('Video submitted for review.');
    form.reset();
    await loadLibrary();
    loadVideos();
  } catch (error) {
    setFormMessage('#upload-message', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function handleReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  setFormMessage('#report-message', 'Submitting report…');
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    const data = await api('/api/reports', { method: 'POST', body: JSON.stringify(payload) });
    setFormMessage('#report-message', data.message || 'Report submitted.');
    toast('Report submitted to the moderation queue.');
    form.reset();
  } catch (error) {
    setFormMessage('#report-message', error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function removeVideo(id) {
  if (!window.confirm('Remove this video from the platform? This action cannot be undone from this screen.')) return;
  try {
    await api(`/api/me/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Video removed.');
    await loadLibrary();
    await loadVideos();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function reviewVideo(id, action) {
  const note = window.prompt(`Optional moderation note for ${action}:`, '') || '';
  try {
    await api(`/api/moderation/videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action, note }) });
    toast(`Video marked ${action === 'publish' ? 'published' : action === 'reject' ? 'rejected' : 'removed'}.`);
    await loadModeration();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function updateReport(id, status) {
  const note = window.prompt(`Optional note for report status “${status}”:`, '') || '';
  try {
    await api(`/api/moderation/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status, note }) });
    toast(`Report marked ${status}.`);
    await loadModeration();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setSearch(query) {
  state.query = String(query || '').trim().slice(0, 100);
  state.offset = 0;
  state.latest = false;
  state.category = '';
  $('#search-input').value = state.query;
  renderChips();
  showView('discover');
}

function bindEvents() {
  $('#age-enter').addEventListener('click', () => {
    sessionStorage.setItem('nightstream-adult-confirmed', 'yes');
    $('#age-gate').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    loadVideos();
  });
  if (sessionStorage.getItem('nightstream-adult-confirmed') === 'yes') {
    $('#age-gate').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
  }
  $('#year').textContent = String(new Date().getFullYear());
  $('#account-button').addEventListener('click', () => {
    if (state.user) {
      state.token = '';
      state.user = null;
      sessionStorage.removeItem('nightstream-token');
      renderCurrentUser();
      toast('Signed out.');
    } else openAuth('login');
  });
  $('#auth-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-auth-mode]');
    if (!tab) return;
    state.authMode = tab.dataset.authMode;
    renderAuthForm();
  });
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#upload-form').addEventListener('submit', handleUpload);
  $('#report-form').addEventListener('submit', handleReport);
  $('#upload-open').addEventListener('click', openUpload);
  $('#studio-upload').addEventListener('click', openUpload);
  $('#studio-account').addEventListener('click', () => state.user ? toast(`Signed in as ${state.user.username}. Age assurance: ${state.user.ageAssuranceStatus}.`) : openAuth('login'));
  $('#report-video').addEventListener('click', () => openReport(state.currentVideo?.id || ''));
  $('#general-report').addEventListener('click', () => openReport(''));
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
  $('#search-form').addEventListener('submit', (event) => { event.preventDefault(); setSearch($('#search-input').value); });
  $('#load-more').addEventListener('click', () => loadVideos({ append: true }));
  document.body.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) showView(viewButton.dataset.view);
    const closeButton = event.target.closest('[data-close]');
    if (closeButton) closeModal(closeButton.dataset.close);
    const categoryButton = event.target.closest('[data-category-card]');
    if (categoryButton) {
      state.category = categoryButton.dataset.categoryCard;
      renderChips();
      showView('discover');
      loadVideos();
    }
    const videoButton = event.target.closest('[data-play-video]');
    if (videoButton) openVideo(videoButton.dataset.playVideo);
    const removeButton = event.target.closest('[data-remove-video]');
    if (removeButton) removeVideo(removeButton.dataset.removeVideo);
    const reviewButton = event.target.closest('[data-review-video]');
    if (reviewButton) reviewVideo(reviewButton.dataset.reviewVideo, reviewButton.dataset.reviewAction);
    const reportButton = event.target.closest('[data-report-status]');
    if (reportButton) updateReport(reportButton.dataset.reportId, reportButton.dataset.reportStatus);
    if (event.target.closest('[data-retry-videos]')) loadVideos();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $$('.modal:not(.hidden)').forEach((modal) => closeModal(modal.id));
      $('#sidebar').classList.remove('mobile-open');
    }
  });
}

async function init() {
  bindEvents();
  renderChips();
  renderCategoryCards();
  await refreshUser();
  if (!$('#age-gate').classList.contains('hidden')) return;
  loadVideos();
}

init();

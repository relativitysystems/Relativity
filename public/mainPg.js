// === Theme setup ===
const THEME_STORAGE_KEY = 'relativity-theme';

const themeStyles = document.createElement('style');
themeStyles.textContent = `
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f7f7f3;
    --surface: #ffffff;
    --border: #dedbd2;
    --text: #101010;
    --text-muted: #6b6b63;
    --text-secondary: #3f3f39;
    --error: #b42318;
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #000;
    --surface: #0d0d0d;
    --border: #1a1a1a;
    --text: #fff;
    --text-muted: #555;
    --text-secondary: #888;
    --error: #ff7a7a;
  }

  .theme-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 13px;
    margin-left: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition), background var(--transition), transform var(--transition);
  }

  .theme-toggle:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--text) 22%, var(--border));
    transform: translateY(-1px);
  }

  .theme-toggle-icon {
    font-size: 0.82rem;
    line-height: 1;
  }

  :root[data-theme="light"] .logo-img {
    filter: invert(1);
  }

  :root[data-theme="light"] nav#nav.scrolled {
    background: rgba(247, 247, 243, 0.82);
  }

  :root[data-theme="light"] .mobile-nav {
    background: rgba(247, 247, 243, 0.97);
  }

  :root[data-theme="light"] .btn-primary {
    background: #101010;
    color: #fff;
  }

  :root[data-theme="light"] .btn-primary:hover {
    background: #2a2a2a;
  }

  :root[data-theme="light"] .btn-outline {
    border-color: rgba(16, 16, 16, 0.16);
    color: #101010;
  }

  :root[data-theme="light"] .btn-outline:hover {
    border-color: rgba(16, 16, 16, 0.34);
    background: rgba(16, 16, 16, 0.04);
  }

  :root[data-theme="light"] .btn-ghost {
    color: rgba(16, 16, 16, 0.62);
  }

  :root[data-theme="light"] .btn-ghost:hover,
  :root[data-theme="light"] .nav-links a:hover {
    color: #101010;
  }

  :root[data-theme="light"] .dim-text {
    color: rgba(16, 16, 16, 0.42);
  }

  :root[data-theme="light"] .service-card:hover,
  :root[data-theme="light"] .use-case-card:hover {
    border-color: rgba(16, 16, 16, 0.14);
    background: #fbfbf8;
  }

  :root[data-theme="light"] .service-card li::before,
  :root[data-theme="light"] .footer-copy {
    color: #b6b2a8;
  }

  :root[data-theme="light"] .contact-form input,
  :root[data-theme="light"] .contact-form textarea {
    color: var(--text);
  }

  :root[data-theme="light"] .contact-form input:focus,
  :root[data-theme="light"] .contact-form textarea:focus {
    border-color: rgba(16, 16, 16, 0.28);
  }

  :root[data-theme="light"] .form-status.success {
    color: #287044;
  }

  :root[data-theme="light"] .demo-chat-window {
    box-shadow: 0 24px 70px rgba(16, 16, 16, 0.08);
  }

  :root[data-theme="light"] .demo-chrome,
  :root[data-theme="light"] .demo-sidebar {
    background: #f1f0ea;
  }

  :root[data-theme="light"] .demo-chrome-dots span {
    background: #d0ccc1;
  }

  :root[data-theme="light"] .demo-sidebar {
    border-right-color: rgba(16, 16, 16, 0.08);
  }

  :root[data-theme="light"] .document-row:hover,
  :root[data-theme="light"] .history-item:hover,
  :root[data-theme="light"] .history-item--active {
    background: rgba(16, 16, 16, 0.045);
  }

  :root[data-theme="light"] .demo-chat-header {
    background: rgba(16, 16, 16, 0.015);
  }

  :root[data-theme="light"] .demo-message-user {
    background: rgba(16, 16, 16, 0.025);
    border-left-color: #d8d4ca;
  }

  :root[data-theme="light"] .source-pill,
  :root[data-theme="light"] .trust-preview,
  :root[data-theme="light"] .how-it-works-note {
    background: rgba(16, 16, 16, 0.018);
  }

  :root[data-theme="light"] .knowledge-gap-preview {
    border-color: rgba(16, 16, 16, 0.08);
    background: rgba(16, 16, 16, 0.025);
  }

  :root[data-theme="light"] .trust-badge {
    border-color: rgba(16, 16, 16, 0.1);
  }

  :root[data-theme="light"] .prompt-pill:hover {
    border-color: rgba(16, 16, 16, 0.18);
  }

  @media (max-width: 700px) {
    .theme-toggle {
      padding: 8px 10px;
      margin-left: 10px;
      font-size: 0.72rem;
    }
  }
`;
document.head.appendChild(themeStyles);

const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
const initialTheme = savedTheme === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = initialTheme;

function createThemeToggle() {
  const navInner = document.querySelector('.nav-inner');
  if (!navInner) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-toggle';
  button.setAttribute('aria-label', 'Toggle color theme');
  button.innerHTML = '<span class="theme-toggle-icon" aria-hidden="true"></span><span class="theme-toggle-text"></span>';
  navInner.appendChild(button);
  return button;
}

const themeToggle = createThemeToggle();

function applyTheme(theme) {
  const safeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = safeTheme;
  localStorage.setItem(THEME_STORAGE_KEY, safeTheme);

  if (themeToggle) {
    const icon = themeToggle.querySelector('.theme-toggle-icon');
    const text = themeToggle.querySelector('.theme-toggle-text');
    const nextTheme = safeTheme === 'dark' ? 'light' : 'dark';

    if (icon) icon.textContent = safeTheme === 'dark' ? '☾' : '☀';
    if (text) text.textContent = safeTheme === 'dark' ? 'Dark' : 'Light';
    themeToggle.setAttribute('aria-pressed', safeTheme === 'dark');
    themeToggle.setAttribute('title', `Switch to ${nextTheme} mode`);
  }
}

applyTheme(initialTheme);

themeToggle?.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
});

// === Starfield ===
const canvas = document.getElementById('starfield');
const ctx = canvas.getContext('2d');
let stars = [];
let rafId;

function resize() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  initStars();
}

function initStars() {
  stars = [];
  const density = 6500;
  const count = Math.floor((canvas.width * canvas.height) / density);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.1 + 0.1,
      o: Math.random() * 0.9 + 0.4,
      speed: Math.random() * 0.20 + 0.03,
    });
  }
}

function tick() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const isDark = document.documentElement.dataset.theme === 'dark';
  for (const s of stars) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? `rgba(255,255,255,${s.o})` : `rgba(16,16,16,${s.o * 0.45})`;
    ctx.fill();
    s.y -= s.speed;
    if (s.y + s.r < 0) {
      s.y = canvas.height + s.r;
      s.x = Math.random() * canvas.width;
    }
  }
  rafId = requestAnimationFrame(tick);
}

// Pause animation when tab is hidden to save resources
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    tick();
  }
});

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(canvas.parentElement);
resize();
tick();

// === Nav scroll state ===
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// === Mobile menu ===
const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
const mobileNav = document.getElementById('mobileNav');

mobileMenuBtn.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('menu-open');
  mobileMenuBtn.setAttribute('aria-expanded', isOpen);
});

mobileNav.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    nav.classList.remove('menu-open');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
  });
});

// === Scroll-triggered fade-ins ===
const fadeEls = document.querySelectorAll('.fade-in');
const ioOptions = { threshold: 0.1, rootMargin: '0px 0px -48px 0px' };

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      // Stagger cards in a grid if siblings
      const parent = entry.target.parentElement;
      const siblings = [...parent.querySelectorAll('.fade-in')];
      const idx = siblings.indexOf(entry.target);
      const isGrid = parent.classList.contains('services-grid') || parent.classList.contains('process-steps') || parent.classList.contains('use-cases-grid');
      const delay = isGrid ? idx * 80 : 0;
      setTimeout(() => entry.target.classList.add('visible'), delay);
      io.unobserve(entry.target);
    }
  }
}, ioOptions);

for (const el of fadeEls) io.observe(el);

// === Contact form ===
const form = document.getElementById('contactForm');
const status = document.getElementById('formStatus');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  submitBtn.textContent = 'Sending…';
  submitBtn.disabled = true;
  status.textContent = '';
  status.className = 'form-status';

  const data = {
    name:    form.elements['name'].value,
    email:   form.elements['email'].value,
    phone:   form.elements['phone'].value,
    company: form.elements['company'].value,
    message: form.elements['message'].value,
    website: form.elements['website'].value,
  };

  try {
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      status.textContent = "Message received. I'll reach out shortly.";
      status.classList.add('success');
      form.reset();
    } else {
      const body = await res.json().catch(() => ({}));
      status.textContent = body.error || 'Something went wrong. Please try again.';
      status.classList.add('error');
    }
  } catch {
    status.textContent = 'Network error. Please check your connection and try again.';
    status.classList.add('error');
  }

  submitBtn.textContent = 'Send Message';
  submitBtn.disabled = false;
});

// === Smooth scroll for anchor links ===
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});
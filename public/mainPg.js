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
  for (const s of stars) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${s.o})`;
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
      const isGrid = parent.classList.contains('services-grid') || parent.classList.contains('process-steps');
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

form.addEventListener('submit', (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  submitBtn.textContent = 'Sending...';
  submitBtn.disabled = true;
  status.textContent = '';
  status.className = 'form-status';

  // Placeholder: swap this out for Formspree / backend endpoint
  setTimeout(() => {
    status.textContent = "Message received. We'll be in touch within 24 hours.";
    status.classList.add('success');
    form.reset();
    submitBtn.textContent = 'Send Message';
    submitBtn.disabled = false;
  }, 900);
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

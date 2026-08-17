// HORMACHUELOS — cyber/terminal design layer (boot, particles, cursor)
// Pure presentation chrome. All page logic lives in app.js.
(function () {
  'use strict';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  /* ---------- Boot sequence ---------- */
  const boot = document.getElementById('boot');
  const bootText = document.getElementById('bootText');
  const bootMsgs = [
    'INITIALIZING HORMACHUELOS SYSTEMS...',
    'LOADING MODEL ROUTERS...',
    'CALIBRATING GCASH INTERFACE...',
    'SYSTEM ONLINE.'
  ];
  let bootIdx = 0;
  const finishBoot = () => {
    if (boot) boot.classList.add('hidden');
  };
  if (reduced || !boot) {
    finishBoot();
  } else {
    const bootTimer = setInterval(() => {
      bootIdx++;
      if (bootIdx < bootMsgs.length) {
        if (bootText) bootText.textContent = bootMsgs[bootIdx];
      } else {
        clearInterval(bootTimer);
        setTimeout(finishBoot, 300);
      }
    }, 500);
    // Safety: never trap the page behind the overlay.
    setTimeout(finishBoot, 3500);
  }

  /* ---------- Background particle network ---------- */
  const canvas = document.getElementById('bg');
  let particles = [];
  let rafId = 0;
  let W = 0;
  let H = 0;
  const mouse = { x: -9999, y: -9999 };
  const CYAN = '111,224,245';

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(window.innerWidth * dpr);
    H = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    initParticles();
  }

  const COUNT = 90;
  function initParticles() {
    particles = [];
    for (let i = 0; i < COUNT; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: (Math.random() * 1.6 + 0.6) * (window.devicePixelRatio || 1)
      });
    }
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;

      const dm = Math.hypot(p.x - mouse.x, p.y - mouse.y);
      if (dm < 160 * (window.devicePixelRatio || 1)) {
        ctx.strokeStyle = `rgba(${CYAN},${(1 - dm / 160) * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(${CYAN},0.7)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i];
        const b = particles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 120 * (window.devicePixelRatio || 1)) {
          ctx.strokeStyle = `rgba(${CYAN},${(1 - d / 120) * 0.25})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  if (canvas && !reduced) {
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (e) => {
      mouse.x = e.clientX * (window.devicePixelRatio || 1);
      mouse.y = e.clientY * (window.devicePixelRatio || 1);
    }, { passive: true });
    draw();
  }

  /* ---------- Custom cursor ---------- */
  const dot = document.getElementById('cursorDot');
  const ring = document.getElementById('cursorRing');
  let mx = 0;
  let my = 0;
  let rx = 0;
  let ry = 0;

  if (dot && ring && !reduced && window.matchMedia?.('(hover: hover)')?.matches) {
    window.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
    }, { passive: true });

    const ringLoop = () => {
      rx += (mx - rx) * 0.15;
      ry += (my - ry) * 0.15;
      ring.style.left = rx + 'px';
      ring.style.top = ry + 'px';
      requestAnimationFrame(ringLoop);
    };
    ringLoop();

    const hoverTargets = 'a, button, .project, input, textarea, select, .tools span, .ix-card, .trust-chip';
    document.addEventListener('mouseover', (e) => {
      if (e.target.closest(hoverTargets)) ring.classList.add('hover');
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest(hoverTargets)) ring.classList.remove('hover');
    });
  }
})();

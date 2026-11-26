(() => {
  'use strict';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style = document.createElement('style');
  style.textContent = `
    .gw-pixel-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;opacity:.58}
    .topbar{z-index:5}
    .gw-reveal{opacity:0;transform:translateY(18px);transition:opacity .65s ease,transform .65s cubic-bezier(.2,.7,.2,1)}
    .gw-reveal.gw-visible{opacity:1;transform:translateY(0)}
    .card.gw-reveal{transition:opacity .5s ease,transform .5s cubic-bezier(.2,.7,.2,1),box-shadow .2s}
    .hero-copy.gw-reveal{transition-delay:.08s}
    .publish-intro.gw-reveal{transition-delay:.06s}
    .gw-pixel-canvas{animation:gwCanvasIn 1.2s ease both}
    @keyframes gwCanvasIn{from{opacity:0}to{opacity:.58}}
    @media(prefers-reduced-motion:reduce){.gw-reveal,.gw-reveal.gw-visible{opacity:1!important;transform:none!important;transition:none!important}.gw-pixel-canvas{animation:none!important;opacity:.25}}
  `;
  document.head.appendChild(style);

  const canvas = document.createElement('canvas');
  canvas.className = 'gw-pixel-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  let width = 0, height = 0, dpr = 1, lastFrame = 0;
  const pixels = [];
  const palette = ['212,255,99', '166,140,255', '255,255,255'];
  const isSmall = matchMedia('(max-width: 620px)').matches;
  const targetCount = reduceMotion ? 18 : (isSmall ? 34 : 58);
  const rand = (min, max) => min + Math.random() * (max - min);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function makePixel(randomY = true) {
    return {
      x: rand(0, width), y: randomY ? rand(0, height) : rand(height * .35, height),
      size: rand(1.4, 3.2), phase: rand(0, Math.PI * 2), speed: rand(.00045, .0012),
      color: palette[Math.floor(Math.random() * palette.length)], drift: rand(-.12, .12)
    };
  }
  function seed() { pixels.length = 0; for (let i = 0; i < targetCount; i++) pixels.push(makePixel()); }
  resize(); seed();
  window.addEventListener('resize', () => { resize(); seed(); }, { passive: true });

  function draw(time) {
    if (document.hidden) { requestAnimationFrame(draw); return; }
    if (!reduceMotion && time - lastFrame < 32) { requestAnimationFrame(draw); return; }
    lastFrame = time;
    ctx.clearRect(0, 0, width, height);
    for (let i = pixels.length - 1; i >= 0; i--) {
      const p = pixels[i];
      if (!reduceMotion) { p.y -= p.speed * 18; p.x += p.drift; }
      if (p.y < -8) { pixels[i] = makePixel(false); pixels[i].y = height + 5; continue; }
      const fade = .18 + (Math.sin(time * p.speed + p.phase) + 1) * .31;
      ctx.fillStyle = `rgba(${p.color},${reduceMotion ? .16 : fade})`;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const age = (time - b.start) / b.life;
      if (age >= 1) { bursts.splice(i, 1); continue; }
      const alpha = (1 - age) * .82;
      ctx.fillStyle = `rgba(${b.color},${alpha})`;
      ctx.fillRect(Math.round(b.x + b.vx * age * 36), Math.round(b.y + b.vy * age * 36), b.size, b.size);
    }
    requestAnimationFrame(draw);
  }
  const bursts = [];
  requestAnimationFrame(draw);

  if (!reduceMotion) {
    window.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const amount = isSmall ? 7 : 11;
      for (let i = 0; i < amount; i++) bursts.push({
        x: event.clientX, y: event.clientY,
        vx: rand(-1.6, 1.6), vy: rand(-1.8, 1.2),
        size: rand(2, 4), color: palette[Math.floor(Math.random() * 2)],
        start: performance.now(), life: rand(420, 780)
      });
    }, { passive: true });
  }

  const observed = new WeakSet();
  const revealObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('gw-visible');
        revealObserver.unobserve(entry.target);
      }
    }
  }, { threshold: .08, rootMargin: '0px 0px -24px 0px' }) : null;
  function addReveal(element) {
    if (!element || observed.has(element)) return;
    observed.add(element);
    element.classList.add('gw-reveal');
    if (reduceMotion || !revealObserver) element.classList.add('gw-visible');
    else revealObserver.observe(element);
  }
  function scan(root = document) {
    root.querySelectorAll('.hero-copy,.section-head,.publish-intro,.form,.footer,.card').forEach(addReveal);
  }
  scan();
  const grid = document.querySelector('#grid');
  if (grid && 'MutationObserver' in window) {
    new MutationObserver(() => scan(grid)).observe(grid, { childList: true });
  }
})();

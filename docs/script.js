/* dsh-effort-sync site — particle mesh, reveal-on-scroll, copy buttons.
   No dependencies, no network, no fonts to wait for. */
(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- reveal on scroll ---------------- */
  var revealables = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduce || !('IntersectionObserver' in window)) {
    revealables.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        // tiny stagger so a row of cards doesn't pop as one block
        setTimeout(function () { el.classList.add('is-in'); }, Math.min(i * 70, 280));
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
  }

  /* ---------------- copy buttons ---------------- */
  document.querySelectorAll('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var done = function () {
        var old = btn.textContent;
        btn.textContent = 'COPIED';
        btn.classList.add('done');
        setTimeout(function () { btn.textContent = old; btn.classList.remove('done'); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
        return;
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
      document.body.removeChild(ta);
      done();
    });
  });

  /* ---------------- particle mesh background ---------------- */
  var canvas = document.getElementById('mesh');
  if (!canvas || reduce) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var nodes = [];
  var w = 0;
  var h = 0;
  var dpr = 1;
  var raf = null;
  var running = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    // Density scales with area but stays small: this is wallpaper, not a toy.
    var count = Math.max(18, Math.min(74, Math.round((w * h) / 26000)));
    nodes = [];
    for (var i = 0; i < count; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.3 + 0.5,
        warm: Math.random() > 0.72 // a few violet nodes for depth
      });
    }
  }

  function link(a, b, style) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var d2 = dx * dx + dy * dy;
    var limit = 15000;
    if (d2 > limit) return;
    var t = 1 - d2 / limit;
    ctx.strokeStyle = style === 'violet'
      ? 'rgba(167, 139, 250, ' + (t * 0.30).toFixed(3) + ')'
      : 'rgba(34, 211, 238, ' + (t * 0.26).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < -20) n.x = w + 20;
      if (n.x > w + 20) n.x = -20;
      if (n.y < -20) n.y = h + 20;
      if (n.y > h + 20) n.y = -20;
    }

    for (var a = 0; a < nodes.length; a++) {
      for (var b = a + 1; b < nodes.length; b++) {
        link(nodes[a], nodes[b], nodes[a].warm || nodes[b].warm ? 'violet' : 'cyan');
      }
    }

    for (var k = 0; k < nodes.length; k++) {
      var m = nodes[k];
      ctx.fillStyle = m.warm ? 'rgba(167, 139, 250, 0.75)' : 'rgba(34, 211, 238, 0.8)';
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = window.requestAnimationFrame(frame);
  }

  function start() {
    if (running && raf === null) raf = window.requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf !== null) {
      window.cancelAnimationFrame(raf);
      raf = null;
    }
  }

  resize();
  start();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 180);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      running = true;
      start();
    }
  });
})();

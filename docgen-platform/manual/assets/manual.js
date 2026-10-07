/* ─────────────────────────────────────────────────────────────
   คู่มือ Carbone ภาษาไทย — script
   ไม่มี dependency ไม่ต้อง build
   ───────────────────────────────────────────────────────────── */
;(function () {
  'use strict';

  var doc = document;

  /* ── 1 · เมนูบนจอเล็ก ─────────────────────────────────── */
  var navToggle = doc.getElementById('navToggle');
  var sidenav = doc.getElementById('sidenav');

  function closeNav() {
    if (!sidenav || !navToggle) return;
    sidenav.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }

  if (navToggle && sidenav) {
    navToggle.addEventListener('click', function () {
      var open = sidenav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // กดเมนูแล้วเลือกหัวข้อ → ปิดเมนู แล้วเลื่อนไปที่หัวข้อนั้น
    sidenav.addEventListener('click', function (ev) {
      if (ev.target && ev.target.tagName === 'A') closeNav();
    });
  }

  /* ── 2 · ไฮไลต์เมนูข้างตามตำแหน่งที่เลื่อน ───────────── */
  var navLinks = Array.prototype.slice.call(doc.querySelectorAll('.sidenav a[href^="#"]'));
  var sections = navLinks
    .map(function (a) { return doc.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);

  function markActive(id) {
    navLinks.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + id);
    });
  }

  /**
   * ⚠️ ห้ามเลือกด้วย `intersectionRatio`
   *
   *   ค่านี้หารด้วย**ความสูงของ section ตัวเอง** ไม่ใช่พื้นที่ที่ว่าง
   *   → section ที่สูงกว่าได้คะแนนสูงกว่า แม้จะทับกับเส้นอ้างอิงน้อยกว่า
   *
   *   วัดได้จริงหลังเลื่อนไปที่หัวข้อ "6 · formatter":
   *     · หัวข้อ 5 (สูง 1076px) ทับเส้น 24px → ratio 0.0227  ← ถูกเลือก
   *     · หัวข้อ 6 (สูง 2085px) ทับเส้น 43px → ratio 0.0207  ← ถูกต้องแต่แพ้
   *   เมนูจึงค้างที่หัวข้อผิดทั้งที่ผู้ใช้เลื่อนถูกที่แล้ว
   *
   *   วิธีที่ถูก: เลือกหัวข้อ**ปัจจุบัน**จากตำแหน่งจริงของกล่อง
   *   = หัวข้ออันสุดท้ายที่ขอบบนของมันเลยเส้นอ้างอิงแล้ว
   */
  var currentId = null;
  var ticking = false;

  function computeActive() {
    if (!sections.length) return;

    // ขณะค้นหาอาจมี section ถูกซ่อน — ต้องข้ามออก ไม่งั้นกล่องที่ซ่อน
    // มีความสูง 0 แล้วผ่านเงื่อนไข "เลยเส้นแล้ว" เสมอ ทำให้เลือกผิด
    var list = [];
    for (var i = 0; i < sections.length; i++) {
      if (!sections[i].hidden) list.push(sections[i]);
    }
    if (!list.length) return;

    var line = 120; // เส้นอ้างอิงใต้แถบบน (topbar 58px + ระยะนิยม)

    var best = list[0];
    for (var j = 0; j < list.length; j++) {
      if (list[j].getBoundingClientRect().top <= line) best = list[j];
      else break; // เรียงตามลำดับในเอกสาร ถึงจุดนี้แล้วข้างล่างยังไม่ถึงเส้น
    }

    // เลื่อนจนสุดล่างแล้วหัวข้อสุดท้ายต้องได้ไฮไลต์ (ไม่งั้นกดข้างล่างแล้วเงาไม่ขยับ)
    var atBottom =
      window.innerHeight + window.scrollY >= doc.documentElement.scrollHeight - 2;
    if (atBottom) best = list[list.length - 1];

    if (best.id !== currentId) {
      currentId = best.id;
      markActive(best.id);
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      computeActive();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  computeActive();

  /* ── 3 · ค้นในคู่มือ ────────────────────────────────────── */
  var search = doc.getElementById('search');

  function clearMarks(scope) {
    scope.querySelectorAll('mark').forEach(function (m) {
      var parent = m.parentNode;
      parent.replaceChild(doc.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  if (search) {
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = search.value.trim();
        var content = doc.getElementById('main');
        if (!content) return;

        clearMarks(content);

        if (q.length < 2) {
          sections.forEach(function (s) { s.hidden = false; });
          navLinks.forEach(function (a) { a.style.display = ''; });
          computeActive(); // ซ่อน/โชว์ใหม่ = ตำแหน่งทุกอย่างขยับ
          return;
        }

        var rx = new RegExp(escapeRegExp(q), 'gi');
        sections.forEach(function (sec) {
          var hit = rx.test(sec.textContent);
          sec.hidden = !hit;
          var link = doc.querySelector('.sidenav a[href="#' + sec.id + '"]');
          if (link) link.style.display = hit ? '' : 'none';
        });
        computeActive();

        // ไฮไลต์คำที่เจอในส่วนที่ยังแสดงอยู่
        content.querySelectorAll('section:not([hidden])').forEach(function (sec) {
          sec.querySelectorAll('h1, h2, h3, p, li, td, code').forEach(function (el) {
            if (el.children.length) return;
            var text = el.textContent;
            if (!rx.test(text)) { rx.lastIndex = 0; return; }
            rx.lastIndex = 0;
            el.innerHTML = text.replace(rx, function (m) {
              return '<mark>' + m.replace(/</g, '&lt;') + '</mark>';
            });
          });
        });
      }, 180);
    });
  }

  /* ── 4 · จำสถานะเช็กบล็อกไว้ในเครื่อง ──────────────────── */
  var KEY = 'carbone-th-manual-checklist';
  var boxes = Array.prototype.slice.call(doc.querySelectorAll('.check input[type=checkbox]'));

  function loadState() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveState(done) {
    try { window.localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) { /* โหมดส่วนตัว */ }
  }

  if (boxes.length) {
    var done = loadState();
    boxes.forEach(function (b, i) { b.checked = done.indexOf(i) !== -1; });
    boxes.forEach(function (b, i) {
      b.addEventListener('change', function () {
        var list = loadState();
        var at = list.indexOf(i);
        if (b.checked && at === -1) list.push(i);
        if (!b.checked && at !== -1) list.splice(at, 1);
        saveState(list);
      });
    });
  }

  /* ── 5 · เปิดเมนูด้วยแป้นพิมพ์บนจอเล็ก ─────────────────── */
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });
})();

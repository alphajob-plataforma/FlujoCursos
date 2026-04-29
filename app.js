const API_URL = 'https://script.google.com/macros/s/AKfycbx-zzIvZ2NXm8vQDskqq2X-gr9QJab-6G-NLNE9tEuYwFlzQfufP9HnDi9ZfKY87Z4R/exec';
const STORAGE_KEY = 'pit-kanban-v4';
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const REORDER_DELAY_MS = 2000;

const STATUS_CYCLE = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
const STATUS_TO_SECTION = { pending: 'pendiente', in_progress: 'desarrollo', done: 'realizado' };

let state = null;
let currentUniFilter = 'all';
let currentCourseFilter = 'all';
let searchTerm = '';
let editingStudentId = null;
let pendingCourseUniId = null;
let reorderTimer = null;
let showOnlyToday = false;

function makeWeeks() { return Array.from({ length: 16 }, () => 'pending') }
function uid() { return Math.random().toString(36).slice(2, 10) }



async function loadState() {
    // Indicador de carga temporal en el UI
    document.getElementById('todayText').textContent = "Sincronizando con nube...";

    try {
        const response = await fetch(API_URL);
        if (response.ok) {
            const data = await response.json();
            // Si la base de datos viene vacía (ej. primera vez), usamos la data por defecto
            if (data.universities && data.universities.length > 0) {
                state = data;
                migrateState(state); // Mantienes tu lógica de migración
            } else {
                state = JSON.parse(JSON.stringify(seedData));
                await saveState(); // Guardamos la data inicial en Sheets
            }
        } else {
            throw new Error("Error en la red");
        }
    } catch (e) {
        console.error('Error cargando de Sheets, usando localFallback', e);
        // Fallback a localStorage si no hay internet
        try {
            const r = localStorage.getItem(STORAGE_KEY);
            if (r) { state = JSON.parse(r); migrateState(state); }
            else { state = JSON.parse(JSON.stringify(seedData)); }
        } catch (err) { state = JSON.parse(JSON.stringify(seedData)); }
    }
}

// Migrate stored data when course structure evolves so the user keeps progress
function migrateState(s) {
    let changed = false;
    for (const u of s.universities) {
        // Split "Formación y Taller" into "Formación para la Investigación" and "Taller de Investigación"
        const idxOld = u.courses.findIndex(c =>
            c.id === 'formacion' ||
            (c.name && c.name.toLowerCase().trim() === 'formación y taller')
        );
        if (idxOld !== -1) {
            const oldCourse = u.courses[idxOld];
            const fiStudents = [];
            const tiStudents = [];
            for (const st of oldCourse.students) {
                if (/^FI[\s\-_]/i.test(st.name)) {
                    st.name = st.name.replace(/^FI[\s\-_]+/i, '');
                    fiStudents.push(st);
                } else if (/^TI[\s\-_]/i.test(st.name)) {
                    st.name = st.name.replace(/^TI[\s\-_]+/i, '');
                    tiStudents.push(st);
                } else {
                    tiStudents.push(st);
                }
            }
            u.courses.splice(idxOld, 1);
            if (fiStudents.length > 0) {
                u.courses.push({ id: 'formacion-investigacion', name: 'Formación para la Investigación', students: fiStudents });
            }
            if (tiStudents.length > 0) {
                u.courses.push({ id: 'taller-investigacion', name: 'Taller de Investigación', students: tiStudents });
            }
            changed = true;
        }
        // Rename "PIT PLAN 2026-1" to "PIT 2026-1"
        for (const c of u.courses) {
            if (c.id === 'pit-plan' || (c.name && /^pit\s*plan\s*2026-1$/i.test(c.name.trim()))) {
                c.name = 'PIT 2026-1';
                c.id = 'pit-2026-1';
                changed = true;
            }
            if (c.id === 'pit' && c.name === 'PIT 2026-0') {
                c.id = 'pit-2026-0';
                changed = true;
            }
        }
        // Ensure new student fields exist + clear legacy manualSection (no longer used)
        for (const c of u.courses) {
            for (const st of c.students) {
                if (st.paid === undefined) { st.paid = true; changed = true; }
                if (st.manualOrder === undefined) { st.manualOrder = null; changed = true; }
                // manualSection is deprecated - section is always derived from current week color
                if (st.manualSection) { st.manualSection = null; changed = true; }
                if (st.manualSection === undefined) { st.manualSection = null; changed = true; }
                // Migrate single classDay to classDays array (allow up to 3 days with times)
                if (!Array.isArray(st.classDays)) {
                    if (typeof st.classDay === 'number') {
                        st.classDays = [{ day: st.classDay, time: null }];
                    } else {
                        st.classDays = [{ day: 1, time: null }];
                    }
                    changed = true;
                }
            }
        }
    }
    return changed;
}
async function saveState() {
    // Primero guardamos en localStorage como backup de seguridad
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Local backup failed', e); }

    // Luego enviamos a Google Sheets
    try {
        fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(state),
            // Mute errors on no-cors if needed, but standard JSON post works with the script above
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
            }
        });
    } catch (e) {
        console.warn('Sync to Google Sheets failed', e);
    }
}

function todayDow() { return new Date().getDay() }
function fmtToday() {
    const d = new Date();
    const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} de ${months[d.getMonth()]}`;
}

function getStudentSection(s) {
    const idx = (s.currentWeek || 1) - 1;
    const cur = s.weeks[idx] || 'pending';
    return STATUS_TO_SECTION[cur];
}

function findStudent(id) {
    for (const u of state.universities)
        for (const c of u.courses) {
            const s = c.students.find(x => x.id === id);
            if (s) return { student: s, course: c, university: u };
        }
    return null;
}

function progressOf(s) {
    const done = s.weeks.filter(w => w === 'done').length;
    return { done, total: 16, pct: Math.round(done / 16 * 100) };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) }

// ============ RENDER ============
function render(opts = {}) {
    const { animate = false } = opts;
    document.getElementById('todayText').textContent = fmtToday();
    renderFilters();

    let oldRects = null;
    if (animate) {
        oldRects = {};
        document.querySelectorAll('.card[data-student-id]').forEach(el => {
            oldRects[el.dataset.studentId] = el.getBoundingClientRect();
        });
    }

    // Calcula el día exacto en Perú (0=Dom, 1=Lun, ..., 6=Sab)
    const todayPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" })).getDay();

    const buckets = { pendiente: [], desarrollo: [], realizado: [] };
    for (const u of state.universities) {
        if (currentUniFilter !== 'all' && currentUniFilter !== u.id) continue;
        for (const c of u.courses) {
            if (currentCourseFilter !== 'all' && currentCourseFilter !== c.id) continue;
            for (const s of c.students) {

                // Filtro de búsqueda por texto
                if (searchTerm && !s.name.toLowerCase().includes(searchTerm.toLowerCase())) continue;

                // --- FILTRO POR DÍA (A prueba de fallos en la carga inicial) ---
                const dayFilterEl = document.getElementById('dayFilter');
                const selectValue = dayFilterEl ? dayFilterEl.value : 'all'; // Lee directo del HTML

                if (selectValue !== 'all') {
                    let targetDay;
                    if (selectValue === 'today') {
                        targetDay = todayPeru; // Usa el día actual en Perú
                    } else {
                        targetDay = parseInt(selectValue); // Usa el número del día (0-6)
                    }

                    const hasClassDay = Array.isArray(s.classDays)
                        ? s.classDays.some(cd => cd.day === targetDay)
                        : (s.classDay === targetDay);

                    if (!hasClassDay) continue; // Si no tiene clase ese día, lo saltamos
                }
                // ---------------------------------------------------------------

                const st = getStudentSection(s);
                buckets[st].push({ student: s, course: c, university: u, status: st });
            }
        }
    }

    const cmpName = (a, b) => a.student.name.localeCompare(b.student.name);
    const firstDay = (s) => Array.isArray(s.classDays) && s.classDays.length > 0
        ? s.classDays[0].day
        : (typeof s.classDay === 'number' ? s.classDay : 0);
    const cmpHier = (a, b) => {
        if (a.university.name !== b.university.name) return a.university.name.localeCompare(b.university.name);
        if (a.course.name !== b.course.name) return a.course.name.localeCompare(b.course.name);
        return firstDay(a.student) - firstDay(b.student);
    };

    // Ordenar primero tarjetas manuales (por manualOrder) y luego el resto
    const sortBucket = (items, defaultCmp) => {
        const manual = items.filter(it => typeof it.student.manualOrder === 'number');
        const auto = items.filter(it => typeof it.student.manualOrder !== 'number');
        manual.sort((a, b) => a.student.manualOrder - b.student.manualOrder);
        auto.sort(defaultCmp);
        return [...manual, ...auto];
    };

    buckets.pendiente = sortBucket(buckets.pendiente, cmpHier);
    buckets.desarrollo = sortBucket(buckets.desarrollo, cmpName);
    buckets.realizado = sortBucket(buckets.realizado, cmpName);

    renderSection('bodyPendiente', buckets.pendiente, 'pendiente');
    renderSection('bodyDesarrollo', buckets.desarrollo, 'desarrollo');
    renderSection('bodyRealizado', buckets.realizado, 'realizado');

    document.getElementById('countPendiente').textContent = buckets.pendiente.length;
    document.getElementById('countDesarrollo').textContent = buckets.desarrollo.length;
    document.getElementById('countRealizado').textContent = buckets.realizado.length;

    if (animate && oldRects) {
        document.querySelectorAll('.card[data-student-id]').forEach(el => {
            const id = el.dataset.studentId;
            const oldRect = oldRects[id];
            if (!oldRect) return;
            const newRect = el.getBoundingClientRect();
            const dx = oldRect.left - newRect.left;
            const dy = oldRect.top - newRect.top;
            if (dx === 0 && dy === 0) return;
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    el.style.transition = 'transform 0.6s cubic-bezier(0.22,0.61,0.36,1)';
                    el.style.transform = '';
                });
            });
            setTimeout(() => {
                el.style.transition = '';
                el.style.transform = '';
            }, 700);
        });
    }

    setupSortable();
}

function renderFilters() {
    const uniWrap = document.getElementById('uniFilters');
    let total = 0;
    for (const u of state.universities) for (const c of u.courses) total += c.students.length;
    let uniHtml = `<button class="chip ${currentUniFilter === 'all' ? 'active' : ''}" data-uni="all">Todas <span class="count">${total}</span></button>`;
    for (const u of state.universities) {
        let count = 0;
        for (const c of u.courses) count += c.students.length;
        uniHtml += `<button class="chip ${currentUniFilter === u.id ? 'active' : ''}" data-uni="${u.id}">${escapeHtml(u.name)} <span class="count">${count}</span></button>`;
    }
    uniWrap.innerHTML = uniHtml;
    uniWrap.querySelectorAll('.chip').forEach(c => {
        c.onclick = () => {
            currentUniFilter = c.dataset.uni;
            currentCourseFilter = 'all';
            cancelReorderTimer();
            render();
        };
    });

    const courseWrap = document.getElementById('courseFilters');
    const visibleCourses = [];
    for (const u of state.universities) {
        if (currentUniFilter !== 'all' && currentUniFilter !== u.id) continue;
        for (const c of u.courses) visibleCourses.push({ uni: u, course: c });
    }
    let totalInScope = 0;
    for (const { course } of visibleCourses) totalInScope += course.students.length;

    let courseHtml = `<button class="chip ${currentCourseFilter === 'all' ? 'active' : ''}" data-course="all">Todos <span class="count">${totalInScope}</span></button>`;
    if (visibleCourses.length === 0) {
        courseHtml += `<span style="font-size:11px;color:var(--muted);font-style:italic;padding:6px">Sin cursos</span>`;
    } else {
        for (const { uni, course } of visibleCourses) {
            const label = currentUniFilter === 'all'
                ? `${escapeHtml(course.name)} <span style="opacity:0.55;font-size:9px">· ${escapeHtml(uni.name)}</span>`
                : escapeHtml(course.name);
            courseHtml += `<button class="chip ${currentCourseFilter === course.id ? 'active' : ''}" data-course="${course.id}">${label} <span class="count">${course.students.length}</span></button>`;
        }
    }
    courseWrap.innerHTML = courseHtml;
    courseWrap.querySelectorAll('.chip').forEach(c => {
        c.onclick = () => {
            currentCourseFilter = c.dataset.course;
            cancelReorderTimer();
            render();
        };
    });
}

function renderSection(bodyId, items, type) {
    const body = document.getElementById(bodyId);
    if (items.length === 0) {
        body.innerHTML = '';
        return;
    }
    body.innerHTML = items.map(it => renderCard(it)).join('');

    body.querySelectorAll('.week-btn').forEach(btn => {
        if (btn.classList.contains('disabled')) return;
        btn.onclick = (e) => {
            e.stopPropagation();
            const sid = btn.closest('.card').dataset.studentId;
            const widx = parseInt(btn.dataset.week);
            cycleWeek(sid, widx);
        };
    });
    body.querySelectorAll('[data-action="edit"]').forEach(b => {
        b.onclick = (e) => {
            e.stopPropagation();
            const sid = b.closest('.card').dataset.studentId;
            openStudentModal(sid);
        };
    });
    body.querySelectorAll('[data-action="payment"]').forEach(b => {
        b.onclick = (e) => {
            e.stopPropagation();
            const sid = b.closest('.card').dataset.studentId;
            togglePayment(sid);
        };
    });
}

function renderCard(it) {
    const { student: s, course: c, university: u } = it;
    const today = todayDow();
    const cw = s.currentWeek || 1;
    const curIdx = cw - 1;
    const prevIdx = cw - 2;

    const stCur = s.weeks[curIdx] || 'pending';
    const visualStatus = STATUS_TO_SECTION[stCur];

    const days = (Array.isArray(s.classDays) && s.classDays.length > 0)
        ? s.classDays
        : [{ day: typeof s.classDay === 'number' ? s.classDay : 1, time: null }];

    const scheduleBadges = days.map(cd => {
        const isToday = cd.day === today;
        const timePart = cd.time ? `<span class="dtime">${escapeHtml(cd.time)}</span>` : '';
        return `<span class="day-badge ${isToday ? 'is-today' : ''}">${DAY_SHORT[cd.day]}${cd.time ? ' ' : ''}${timePart}</span>`;
    }).join('');

    // Aquí está el bloque de texto limpio, sin '.join(" · ")' y como lista
    const horariosTexto = days.map(cd => {
        const dia = DAY_SHORT[cd.day] || '';
        const hora = cd.time ? escapeHtml(cd.time) : '--:--';
        return `<span style="display: block;">${dia} ${hora}</span>`;
    }).join('');

    let prevBtn;
    if (prevIdx < 0) {
        prevBtn = `<div class="week-btn disabled">
      <span class="week-label">Sem. pasada</span>
      <span class="week-num">—</span>
    </div>`;
    } else {
        const st = s.weeks[prevIdx] || 'pending';
        const cls = `s-${st.replace('_', '-')}`;
        prevBtn = `<button class="week-btn ${cls}" data-week="${prevIdx}">
      <span class="week-label">Sem ${prevIdx + 1} · pasada</span>
      <span class="week-num">${prevIdx + 1}</span>
    </button>`;
    }

    const clsCur = `s-${stCur.replace('_', '-')}`;
    const curBtn = `<button class="week-btn ${clsCur}" data-week="${curIdx}">
    <span class="week-current-mark">Esta sem.</span>
    <span class="week-label">Sem ${curIdx + 1}</span>
    <span class="week-num">${curIdx + 1}</span>
  </button>`;

    const isPaid = s.paid !== false;
    const payCls = isPaid ? 'paid' : 'unpaid';
    const payTitle = isPaid ? 'Pagos al día — click para marcar atrasado' : 'Pago atrasado — click para marcar al día';

    return `
    <div class="card is-${visualStatus}" data-student-id="${s.id}">
      <div class="card-head">
        <div class="crumb"><span class="uni">${escapeHtml(u.name)}</span> · ${escapeHtml(c.name)}</div>
      </div>
      <div class="card-name">${escapeHtml(s.name)}</div>
      <div class="schedule-row">${scheduleBadges}</div>
      <div class="weeks-pair">${prevBtn}${curBtn}</div>
      <div class="card-foot">
        <div class="progress-text" style="display: flex; flex-direction: column; gap: 3px; line-height: 1.2;">
          ${horariosTexto}
        </div>
        <div class="card-actions">
          <button class="payment-dot ${payCls}" data-action="payment" title="${payTitle}" aria-label="${payTitle}"></button>
          <button data-action="edit" title="Editar alumno">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

// ============ ACTIONS ============
async function cycleWeek(studentId, weekIdx) {
    const f = findStudent(studentId);
    if (!f) return;
    const cur = f.student.weeks[weekIdx] || 'pending';
    const next = STATUS_CYCLE[cur];
    f.student.weeks[weekIdx] = next;
    await saveState();
    // visual update in place (no re-render yet)
    updateButtonInPlace(studentId, weekIdx, next);
    // Update card's left border color if this is the current week
    if (weekIdx === (f.student.currentWeek || 1) - 1) {
        const card = document.querySelector(`.card[data-student-id="${studentId}"]`);
        if (card) {
            card.classList.remove('is-pendiente', 'is-desarrollo', 'is-realizado');
            card.classList.add(`is-${STATUS_TO_SECTION[next]}`);
        }
    }
    scheduleReorder();
}

async function togglePayment(studentId) {
    const f = findStudent(studentId);
    if (!f) return;
    f.student.paid = !(f.student.paid !== false);
    await saveState();
    // Update visual in place
    const card = document.querySelector(`.card[data-student-id="${studentId}"]`);
    if (!card) return;
    const dot = card.querySelector('.payment-dot');
    if (!dot) return;
    if (f.student.paid) {
        dot.classList.remove('unpaid');
        dot.classList.add('paid');
        dot.title = 'Pagos al día — click para marcar atrasado';
    } else {
        dot.classList.remove('paid');
        dot.classList.add('unpaid');
        dot.title = 'Pago atrasado — click para marcar al día';
    }
}

// ============ DRAG AND DROP ============
let sortableInstances = [];
const SECTION_BY_BODY = {
    bodyPendiente: 'pendiente',
    bodyDesarrollo: 'desarrollo',
    bodyRealizado: 'realizado'
};

function setupSortable(){
  if(typeof Sortable === 'undefined') return;
  sortableInstances.forEach(s=>{ try{ s.destroy(); }catch(e){} });
  sortableInstances = [];

  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  const config = {
    group:'kanban',
    animation:220,
    // En celular SOLO permite mover si la tarjeta tiene la clase 'drag-ready'
    handle: isTouch ? '.drag-ready' : undefined, 
    draggable:'.card',
    ghostClass:'card-ghost',
    chosenClass:'card-chosen',
    dragClass:'card-dragging',
    filter:'button, .week-btn, .payment-dot, [data-action]',
    preventOnFilter:false,
    onEnd: (evt) => {
      // Al soltar la tarjeta, le quitamos el modo arrastre
      if(evt.item) evt.item.classList.remove('drag-ready');
      handleDragEnd(evt);
    }
  };

  ['bodyPendiente','bodyDesarrollo','bodyRealizado'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    sortableInstances.push(Sortable.create(el, config));
  });
}

async function handleDragEnd(evt) {
    const SECTION_TO_STATUS = { pendiente: 'pending', desarrollo: 'in_progress', realizado: 'done' };
    for (const [bodyId, section] of Object.entries(SECTION_BY_BODY)) {
        const container = document.getElementById(bodyId);
        if (!container) continue;
        const cards = container.querySelectorAll('.card[data-student-id]');
        const targetStatus = SECTION_TO_STATUS[section];
        cards.forEach((card, idx) => {
            const sid = card.dataset.studentId;
            const f = findStudent(sid);
            if (!f) return;
            const s = f.student;
            const curIdx = (s.currentWeek || 1) - 1;
            const oldStatus = s.weeks[curIdx];
            // Sync current week color to the section the card landed in
            if (oldStatus !== targetStatus) {
                s.weeks[curIdx] = targetStatus;
                const btn = card.querySelector(`.week-btn[data-week="${curIdx}"]`);
                if (btn) {
                    btn.classList.remove('s-pending', 's-in-progress', 's-done');
                    btn.classList.add(`s-${targetStatus.replace('_', '-')}`);
                }
                card.classList.remove('is-pendiente', 'is-desarrollo', 'is-realizado');
                card.classList.add(`is-${section}`);
                const progEl = card.querySelector('.progress-text');
                if (progEl) {
                    const prog = progressOf(s);
                    progEl.textContent = `${prog.done}/16 · ${prog.pct}%`;
                }
            }
            // Save manual order so future renders keep this arrangement within the section
            s.manualOrder = idx;
            // Clear legacy manualSection from older version (no longer used)
            if (s.manualSection) {
                s.manualSection = null;
                card.classList.remove('is-manual');
            }
        });
    }
    cancelReorderTimer();
    await saveState();
    updateCountsFromDom();
}

function updateCountsFromDom() {
    const map = { bodyPendiente: 'countPendiente', bodyDesarrollo: 'countDesarrollo', bodyRealizado: 'countRealizado' };
    for (const [bodyId, countId] of Object.entries(map)) {
        const n = document.getElementById(bodyId).querySelectorAll('.card[data-student-id]').length;
        document.getElementById(countId).textContent = n;
    }
}

function updateButtonInPlace(studentId, weekIdx, status) {
    const card = document.querySelector(`.card[data-student-id="${studentId}"]`);
    if (!card) return;
    const btn = card.querySelector(`.week-btn[data-week="${weekIdx}"]`);
    if (!btn) return;
    btn.classList.remove('s-pending', 's-in-progress', 's-done');
    btn.classList.add(`s-${status.replace('_', '-')}`);
}

function scheduleReorder() {
    cancelReorderTimer();
    const pill = document.getElementById('reorderPill');
    pill.classList.remove('show');
    void pill.offsetWidth;
    pill.classList.add('show');
    reorderTimer = setTimeout(() => {
        reorderTimer = null;
        document.getElementById('reorderPill').classList.remove('show');
        render({ animate: true });
    }, REORDER_DELAY_MS);
}

function cancelReorderTimer() {
    if (reorderTimer) {
        clearTimeout(reorderTimer);
        reorderTimer = null;
        document.getElementById('reorderPill').classList.remove('show');
    }
}

// ============ MODAL: STUDENT ============
function openModal(id) { document.getElementById(id).classList.add('show') }
function closeModal(id) { document.getElementById(id).classList.remove('show') }

// Working copy of class days during modal session
let modalClassDays = [];

function openStudentModal(studentId) {
    editingStudentId = studentId;
    const title = document.getElementById('studentModalTitle');
    const delBtn = document.getElementById('deleteStudentBtn');
    const uniSel = document.getElementById('fStudentUni');
    uniSel.innerHTML = state.universities.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    const weekSel = document.getElementById('fStudentWeek');
    weekSel.innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">Semana ${i + 1}</option>`).join('');

    if (studentId) {
        title.textContent = 'Editar alumno';
        delBtn.style.display = 'inline-block';
        const f = findStudent(studentId);
        document.getElementById('fStudentName').value = f.student.name;
        document.getElementById('fStudentUser').value = f.student.usuario || '';
        document.getElementById('fStudentPass').value = f.student.contrasena || '';
        document.getElementById('fStudentCuotas').value = f.student.cuotasPagadas || 0;
        document.getElementById('fStudentNotas').value = f.student.notas || '';
        uniSel.value = f.university.id;
        refreshCourseSelect(f.university.id, f.course.id);
        weekSel.value = f.student.currentWeek || 1;
        // Load classDays (or migrate from single classDay)
        if (Array.isArray(f.student.classDays) && f.student.classDays.length > 0) {
            modalClassDays = JSON.parse(JSON.stringify(f.student.classDays));
        } else if (typeof f.student.classDay === 'number') {
            modalClassDays = [{ day: f.student.classDay, time: null }];
        } else {
            modalClassDays = [{ day: 1, time: null }];
        }
    } else {
        title.textContent = 'Nuevo alumno';
        delBtn.style.display = 'none';
        document.getElementById('fStudentName').value = '';
        document.getElementById('fStudentUser').value = '';
        document.getElementById('fStudentPass').value = '';
        document.getElementById('fStudentCuotas').value = 0;
        document.getElementById('fStudentNotas').value = '';
        uniSel.value = state.universities[0]?.id || '';
        refreshCourseSelect(uniSel.value);
        weekSel.value = 1;
        const td = todayDow();
        modalClassDays = [{ day: td === 0 ? 1 : td, time: null }];
    }
    renderClassDaysEditor();
    openModal('studentModal');
}

function renderClassDaysEditor() {
    const wrap = document.getElementById('classDaysList');
    const dayOpts = [
        [1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'],
        [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']
    ];
    wrap.innerHTML = modalClassDays.map((cd, idx) => {
        const opts = dayOpts.map(([v, l]) => `<option value="${v}" ${cd.day === v ? 'selected' : ''}>${l}</option>`).join('');
        const removable = modalClassDays.length > 1;
        return `
      <div class="class-day-row ${removable ? '' : 'single'}">
        <select class="cd-day" data-idx="${idx}">${opts}</select>
        <input type="time" class="cd-time" data-idx="${idx}" value="${cd.time || ''}" placeholder="--:--">
        ${removable ? `<button type="button" class="cd-remove" data-idx="${idx}" title="Quitar día">×</button>` : ''}
      </div>
    `;
    }).join('');

    wrap.querySelectorAll('.cd-day').forEach(sel => {
        sel.onchange = e => {
            modalClassDays[parseInt(e.target.dataset.idx)].day = parseInt(e.target.value);
        };
    });
    wrap.querySelectorAll('.cd-time').forEach(inp => {
        inp.onchange = e => {
            modalClassDays[parseInt(e.target.dataset.idx)].time = e.target.value || null;
        };
    });
    wrap.querySelectorAll('.cd-remove').forEach(b => {
        b.onclick = () => {
            modalClassDays.splice(parseInt(b.dataset.idx), 1);
            renderClassDaysEditor();
        };
    });

    const addBtn = document.getElementById('addClassDayBtn');
    if (modalClassDays.length >= 3) {
        addBtn.disabled = true;
        addBtn.textContent = 'Máximo 3 días alcanzado';
    } else {
        addBtn.disabled = false;
        addBtn.textContent = '+ Agregar día';
    }
}

function addClassDay() {
    if (modalClassDays.length >= 3) return;
    // Pick a day not already used, defaulting to today
    const used = new Set(modalClassDays.map(cd => cd.day));
    let pick = todayDow();
    if (used.has(pick) || pick === 0) {
        for (let d = 1; d <= 6; d++) { if (!used.has(d)) { pick = d; break; } }
    }
    modalClassDays.push({ day: pick, time: null });
    renderClassDaysEditor();
}

function refreshCourseSelect(uniId, selectedCourseId) {
    const sel = document.getElementById('fStudentCourse');
    const u = state.universities.find(x => x.id === uniId);
    if (!u) { sel.innerHTML = '<option>Sin cursos</option>'; return; }
    sel.innerHTML = u.courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (selectedCourseId) sel.value = selectedCourseId;
}

async function saveStudent() {
    const name = document.getElementById('fStudentName').value.trim();
    if (!name) { alert('Falta el nombre del alumno'); return; }
    const uniId = document.getElementById('fStudentUni').value;
    const courseId = document.getElementById('fStudentCourse').value;
    const week = parseInt(document.getElementById('fStudentWeek').value);
    const usuario = document.getElementById('fStudentUser').value.trim();
    const contrasena = document.getElementById('fStudentPass').value.trim();
    const cuotasPagadas = parseInt(document.getElementById('fStudentCuotas').value) || 0;
    const notas = document.getElementById('fStudentNotas').value.trim();
    const u = state.universities.find(x => x.id === uniId);
    const c = u?.courses.find(x => x.id === courseId);
    if (!u || !c) { alert('Selecciona universidad y curso válidos'); return; }

    // Validate classDays: at least 1, no duplicate days
    if (modalClassDays.length === 0) { alert('Agrega al menos un día de clase'); return; }
    const seen = new Set();
    for (const cd of modalClassDays) {
        if (seen.has(cd.day)) {
            alert('No puedes tener el mismo día repetido. Quita o cambia uno.');
            return;
        }
        seen.add(cd.day);
    }
    const classDays = JSON.parse(JSON.stringify(modalClassDays));

    if (editingStudentId) {
        const f = findStudent(editingStudentId);
        if (f.university.id !== uniId || f.course.id !== courseId) {
            f.course.students = f.course.students.filter(x => x.id !== editingStudentId);
            c.students.push(f.student);
        }
        f.student.name = name;
        f.student.classDays = classDays;
        delete f.student.classDay; // remove deprecated single-day field
        f.student.currentWeek = week;
        f.student.usuario = usuario;
        f.student.contrasena = contrasena;
        f.student.cuotasPagadas = cuotasPagadas;
        f.student.notas = notas;
    } else {
        c.students.push({
            id: uid(),
            name,
            classDays,
            currentWeek: week,
            weeks: makeWeeks(),
            paid: true,
            manualSection: null,
            manualOrder: null,
            usuario: usuario,
            contrasena: contrasena,
            cuotasPagadas: cuotasPagadas,
            notas: notas
        });
    }
    await saveState();
    closeModal('studentModal');
    cancelReorderTimer();
    render();
}

async function deleteStudent() {
    if (!editingStudentId) return;
    if (!confirm('¿Eliminar este alumno permanentemente?')) return;
    const f = findStudent(editingStudentId);
    f.course.students = f.course.students.filter(x => x.id !== editingStudentId);
    await saveState();
    closeModal('studentModal');
    cancelReorderTimer();
    render();
}

// ============ MODAL: SETTINGS ============
function openSettings() { renderTree(); openModal('settingsModal'); }

function renderTree() {
    const tree = document.getElementById('treeView');
    if (state.universities.length === 0) {
        tree.innerHTML = '<div class="empty-section">Sin universidades aún</div>';
        return;
    }
    tree.innerHTML = state.universities.map(u => `
    <div class="tree-uni">
      <div class="tree-uni-head">
        <span class="name">${escapeHtml(u.name)}</span>
        <div style="display:flex;gap:6px">
          <button class="mini-btn" data-uni-add="${u.id}">+ curso</button>
          <button class="mini-btn" data-uni-rename="${u.id}">renombrar</button>
          <button class="mini-btn" data-uni-del="${u.id}" style="color:var(--pendiente)">×</button>
        </div>
      </div>
      <div class="tree-courses">
        ${u.courses.length === 0 ? '<div style="padding:8px;color:var(--muted);font-size:12px;font-style:italic">Sin cursos</div>' :
            u.courses.map(c => `
            <div class="tree-course">
              <div>
                <div class="cname">${escapeHtml(c.name)}</div>
                <div class="cmeta">${c.students.length} alumnos</div>
              </div>
              <div class="week-ctrl">
                <span style="color:var(--muted);font-size:10px">Sem:</span>
                <button data-batch-back="${u.id}::${c.id}" title="Retroceder semana de todos">−</button>
                <button data-batch-fwd="${u.id}::${c.id}" title="Avanzar semana de todos">+</button>
                <button class="mini-btn" data-course-rename="${u.id}::${c.id}">✎</button>
                <button class="mini-btn" data-course-del="${u.id}::${c.id}" style="color:var(--pendiente)">×</button>
              </div>
            </div>
          `).join('')
        }
      </div>
    </div>
  `).join('');

    const onTree = (sel, fn) => tree.querySelectorAll(sel).forEach(b => b.onclick = fn(b));
    onTree('[data-uni-add]', b => () => {
        const u = state.universities.find(x => x.id === b.dataset.uniAdd);
        pendingCourseUniId = u.id;
        document.getElementById('fCourseUni').value = u.name;
        document.getElementById('fCourseName').value = '';
        openModal('courseModal');
    });
    onTree('[data-uni-rename]', b => async () => {
        const u = state.universities.find(x => x.id === b.dataset.uniRename);
        const nv = prompt('Nuevo nombre de universidad:', u.name);
        if (nv && nv.trim()) { u.name = nv.trim(); await saveState(); renderTree(); render(); }
    });
    onTree('[data-uni-del]', b => async () => {
        const u = state.universities.find(x => x.id === b.dataset.uniDel);
        if (!confirm(`Eliminar "${u.name}" y todos sus cursos y alumnos?`)) return;
        state.universities = state.universities.filter(x => x.id !== u.id);
        await saveState(); renderTree(); render();
    });
    onTree('[data-course-rename]', b => async () => {
        const [uid, cid] = b.dataset.courseRename.split('::');
        const u = state.universities.find(x => x.id === uid);
        const c = u.courses.find(x => x.id === cid);
        const nv = prompt('Nuevo nombre del curso:', c.name);
        if (nv && nv.trim()) { c.name = nv.trim(); await saveState(); renderTree(); render(); }
    });
    onTree('[data-course-del]', b => async () => {
        const [uid, cid] = b.dataset.courseDel.split('::');
        const u = state.universities.find(x => x.id === uid);
        const c = u.courses.find(x => x.id === cid);
        if (!confirm(`Eliminar "${c.name}" y sus ${c.students.length} alumnos?`)) return;
        u.courses = u.courses.filter(x => x.id !== cid);
        await saveState(); renderTree(); render();
    });
    onTree('[data-batch-fwd]', b => async () => {
        const [uid, cid] = b.dataset.batchFwd.split('::');
        const u = state.universities.find(x => x.id === uid);
        const c = u.courses.find(x => x.id === cid);
        c.students.forEach(s => { if ((s.currentWeek || 1) < 16) s.currentWeek = (s.currentWeek || 1) + 1; });
        await saveState(); renderTree(); render();
    });
    onTree('[data-batch-back]', b => async () => {
        const [uid, cid] = b.dataset.batchBack.split('::');
        const u = state.universities.find(x => x.id === uid);
        const c = u.courses.find(x => x.id === cid);
        c.students.forEach(s => { if ((s.currentWeek || 1) > 1) s.currentWeek = (s.currentWeek || 1) - 1; });
        await saveState(); renderTree(); render();
    });
}

async function addUni() {
    const v = document.getElementById('fNewUni').value.trim();
    if (!v) return;
    const id = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid();
    if (state.universities.some(u => u.id === id || u.name.toLowerCase() === v.toLowerCase())) {
        alert('Esta universidad ya existe'); return;
    }
    state.universities.push({ id, name: v, courses: [] });
    document.getElementById('fNewUni').value = '';
    await saveState(); renderTree(); render();
}

async function saveCourse() {
    const v = document.getElementById('fCourseName').value.trim();
    if (!v) return;
    const u = state.universities.find(x => x.id === pendingCourseUniId);
    if (!u) return;
    const id = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + uid().slice(0, 4);
    u.courses.push({ id, name: v, students: [] });
    await saveState();
    closeModal('courseModal');
    renderTree(); render();
}

function bindEvents() {
    document.getElementById('addStudentBtn').onclick = () => openStudentModal(null);
    document.getElementById('settingsBtn').onclick = openSettings;
    document.getElementById('searchInput').oninput = (e) => { searchTerm = e.target.value; cancelReorderTimer(); render(); };
    document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeModal(b.dataset.close); });
    document.querySelectorAll('.modal-bg').forEach(bg => {
        bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('show'); });
    });
    document.getElementById('fStudentUni').onchange = (e) => refreshCourseSelect(e.target.value);
    document.getElementById('saveStudentBtn').onclick = saveStudent;
    document.getElementById('deleteStudentBtn').onclick = deleteStudent;
    document.getElementById('addClassDayBtn').onclick = addClassDay;
    document.getElementById('addUniBtn').onclick = addUni;
    document.getElementById('saveCourseBtn').onclick = saveCourse;
    document.getElementById('fNewUni').addEventListener('keydown', (e) => { if (e.key === 'Enter') addUni(); });
    document.getElementById('fCourseName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCourse(); });
    const dayFilterEl = document.getElementById('dayFilter');
    if (dayFilterEl) {
        dayFilterEl.onchange = (e) => {
            currentDayFilter = e.target.value;

            // Pinta el select de negro (activo) si hay un filtro aplicado
            if (currentDayFilter !== 'all') {
                e.target.classList.add('active');
            } else {
                e.target.classList.remove('active');
            }

            render(); // Vuelve a dibujar el tablero con el filtro aplicado
        };
    }
    // --- DETECTOR DE DOBLE TOQUE PARA MÓVILES (MEJORADO) ---
  const board = document.getElementById('board');
  let lastTapTime = 0; // Variable para medir el tiempo entre toques

  if (board) {
    board.addEventListener('touchstart', function(e) {
      const card = e.target.closest('.card');
      if(!card) return;

      // Si tocaste un botón, ignoramos
      if(e.target.closest('button, .week-btn, .payment-dot, [data-action]')) return;

      const currentTime = new Date().getTime();
      const tapLength = currentTime - lastTapTime;

      // Si el segundo toque ocurre antes de medio segundo (500ms)
      if (tapLength > 0 && tapLength < 500) {
        // ¡ES UN DOBLE TOQUE!
        card.classList.add('drag-ready');
        
        if(navigator.vibrate) navigator.vibrate(50); // Vibración

        // Le damos 3 segundos para empezar a arrastrar, si no, se cancela solo
        clearTimeout(card.dragTimeout);
        card.dragTimeout = setTimeout(() => {
          card.classList.remove('drag-ready');
        }, 3000);

        // Evita comportamientos raros del navegador en el segundo toque
        e.preventDefault(); 
      }
      
      lastTapTime = currentTime;
    }, { passive: false }); // passive: false es necesario para que funcione preventDefault
  }
  // --------------------------------------------------------
}

(async function init() {
    await loadState();
    bindEvents();
    render();
    setInterval(() => { if (!reorderTimer) render(); }, 60 * 1000);
})();

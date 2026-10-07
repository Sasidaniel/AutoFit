// app.js — main application controller
import * as db from './db.js';
import { SEED_EXERCISES } from './seed.js';
import { Stopwatch, RestTimer, formatHMS, playBeep, speak, primeSpeech } from './timer.js';

const KG_TO_LBS = 2.20462;
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

/* ---------------- state ---------------- */
let exercises = [];
let settings = db.getSettings();
let profile = db.getProfile();
let activeSession = db.getActiveSession(); // { id, startedAt, accumulatedSec, running, entries: [...] }
let workouts = db.getWorkouts();
// transient (not persisted) running hold-timers for hold-type exercises (e.g. plank), keyed by "exerciseId:setIdx"
const holdTimers = new Map();

const stopwatch = new Stopwatch((elapsed) => {
  el('workoutTimerDisplay').textContent = formatHMS(elapsed);
});
let restDoneMessage = 'אפשר להמשיך לסט הבא';
const restTimer = new RestTimer({
  onTick: (remaining) => {
    el('restTimeDisplay').textContent = formatHMS(remaining);
  },
  onDone: () => {
    playBeep();
    if (settings.voiceAnnouncements) speak(`זמן המנוחה הסתיים. ${restDoneMessage}`);
    el('restOverlay').classList.add('hidden');
    showToast(`המנוחה הסתיימה — ${restDoneMessage} 💪`);
    notify('זמן המנוחה הסתיים', restDoneMessage);
  },
});

/* ---------------- notifications (best-effort background alerts) ----------------
   iOS/Safari suspends page JS when the app is fully backgrounded or the screen is
   locked, so a true "always fires on time" background alert needs a push server.
   As a best effort: request permission up-front, fire a system Notification whenever
   a timer completes (shows even if the user briefly switched apps/tabs), and
   force every timer to re-check itself the instant the page becomes visible again. */
function requestNotificationPermission() {
  // This also acts as the one required user-gesture to unlock sound/speech on iOS Safari.
  primeSpeech();
  playBeep();
  if (!('Notification' in window)) {
    showToast('באייפון/ספארי אין תמיכה בהתראות מערכת לאתר כזה ללא שרת Push ייעודי — אבל צליל + הכרזה קולית הופעלו עכשיו ויישמעו אוטומטית כל עוד האתר פתוח 🔊');
    return;
  }
  if (Notification.permission === 'granted') { showToast('התראות כבר מאושרות, וגם צליל/קול הופעלו ✅'); return; }
  Notification.requestPermission().then((perm) => {
    showToast(perm === 'granted' ? 'התראות אושרו ✅ (וגם צליל/קול הופעלו)' : 'התראות נחסמו, אך צליל/קול יעבדו כל עוד האתר פתוח');
  }).catch(() => {});
}
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: 'icons/icon-192.png', tag: 'autofit-timer' }); } catch (e) { /* noop */ }
}

let wakeLockRef = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLockRef = await navigator.wakeLock.request('screen');
      wakeLockRef.addEventListener('release', () => { wakeLockRef = null; });
    }
  } catch (e) { /* wake lock not available / denied — timer still stays accurate */ }
}
function releaseWakeLock() {
  if (wakeLockRef) {
    wakeLockRef.release().catch(() => {});
    wakeLockRef = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (activeSession && activeSession.running) {
      stopwatch.forceTick();
    }
    if (restTimer.isRunning()) restTimer.forceTick();
    tickCardioTimers();
    requestWakeLock();
  }
});
// Some browsers only grant the wake lock from within a user gesture — retry on first tap.
document.addEventListener('click', () => { if (!wakeLockRef) requestWakeLock(); }, { once: false });

function el(id) { return document.getElementById(id); }
function qs(sel, parent = document) { return parent.querySelector(sel); }
function qsa(sel, parent = document) { return Array.from(parent.querySelectorAll(sel)); }

/* ---------------- init ---------------- */
function init() {
  exercises = db.getExercises();
  if (!exercises.length) {
    exercises = SEED_EXERCISES.map((e) => ({ id: db.uid(), active: true, ...e }));
    db.saveExercises(exercises);
  } else {
    // migrate older saved exercises that are missing newer fields (images, hold-type, active flag)
    let migrated = false;
    exercises.forEach((ex) => {
      const match = SEED_EXERCISES.find((s) => s.name === ex.name);
      if (!ex.images || (ex.images.length === 0 && match && match.images && match.images.length)) {
        ex.images = match ? match.images : (ex.images || []);
        migrated = true;
      }
      if (match && match.inputType && !ex.inputType) {
        ex.inputType = match.inputType;
        ex.holdSeconds = match.holdSeconds;
        migrated = true;
      }
      if (ex.active === undefined) {
        ex.active = true;
        migrated = true;
      }
      if (ex.restSeconds !== 120) {
        ex.restSeconds = 120;
        migrated = true;
      }
    });
    if (migrated) db.saveExercises(exercises);
    // add any newly introduced seed exercises (by name) that aren't in the user's saved list yet
    const missing = SEED_EXERCISES.filter((s) => !exercises.some((ex) => ex.name === s.name));
    if (missing.length) {
      exercises = [...exercises, ...missing.map((e) => ({ id: db.uid(), active: true, ...e }))];
      db.saveExercises(exercises);
    }
  }
  if (settings.restSeconds !== 120) {
    settings.restSeconds = 120;
    db.saveSettings(settings);
  }
  if (!activeSession) {
    activeSession = buildDraftSession();
  } else {
    // migrate existing active sessions that don't yet have the warm-up/cool-down walk entries
    let sessionMigrated = false;
    if (!activeSession.entries.some((e) => e.exerciseId === 'warmup')) {
      activeSession.entries.unshift(makeCardioEntry('warmup'));
      sessionMigrated = true;
    }
    if (!activeSession.entries.some((e) => e.exerciseId === 'cooldown')) {
      activeSession.entries.push(makeCardioEntry('cooldown'));
      sessionMigrated = true;
    }
    // add newly introduced *active* exercises to the in-progress session too (before the cool-down walk)
    exercises.filter((ex) => ex.active !== false).forEach((ex) => {
      if (!activeSession.entries.some((e) => e.exerciseId === ex.id)) {
        const cooldownIdx = activeSession.entries.findIndex((e) => e.exerciseId === 'cooldown');
        const newEntry = {
          exerciseId: ex.id,
          exerciseName: ex.name,
          sets: Array.from({ length: setsForWeek(ex) }, () => ({ weightKg: '', reps: '', completed: false })),
        };
        if (cooldownIdx === -1) activeSession.entries.push(newEntry);
        else activeSession.entries.splice(cooldownIdx, 0, newEntry);
        sessionMigrated = true;
      }
    });
    if (sessionMigrated) persistActiveSession();
  }

  wireTabs();
  wireWorkoutControls();
  wireSettings();
  wireExercisesTab();
  wireProfileTab();
  wireHistoryTab();
  renderBrand();
  startLiveClock();
  setInterval(tickCardioTimers, 1000);

  renderWorkoutTab();
  renderHistoryTab();
  renderExercisesTab();
  renderSettingsTab();
  renderProfileTab();

  // keep the phone screen on the whole time the site is open, not just during a workout
  requestWakeLock();

  if (activeSession.running) {
    stopwatch.start(new Date(activeSession.startedAt).getTime());
    el('btnStartWorkout').classList.add('hidden');
    el('btnFinishWorkout').classList.remove('hidden');
  }

  renderDashboard(); // initial; chart lib loaded via defer, retry if not ready
  waitForChartJs().then(renderDashboard);

  registerServiceWorker();
}

function waitForChartJs() {
  return new Promise((resolve) => {
    if (window.Chart) return resolve();
    const iv = setInterval(() => {
      if (window.Chart) { clearInterval(iv); resolve(); }
    }, 150);
  });
}

/* ---------------- tabs ---------------- */
function wireTabs() {
  qsa('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(tab) {
  qsa('.tab-panel').forEach((p) => p.classList.remove('active'));
  qsa('.tab-btn').forEach((b) => b.classList.remove('active'));
  el(`tab-${tab}`).classList.add('active');
  qs(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'history') renderHistoryTab();
}

/* ---------------- live clock ---------------- */
function startLiveClock() {
  const tick = () => {
    const now = new Date();
    el('liveClock').textContent = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 30000);
}

/* ================= WORKOUT TAB ================= */
function buildDraftSession() {
  const lastByExercise = getLastCompletedValuesByExercise();
  return {
    id: db.uid(),
    startedAt: null,
    accumulatedSec: 0,
    running: false,
    entries: [
      makeCardioEntry('warmup'),
      ...exercises.filter((ex) => ex.active !== false).map((ex) => ({
        exerciseId: ex.id,
        exerciseName: ex.name,
        sets: Array.from({ length: setsForWeek(ex) }, (_, i) => {
          const last = lastByExercise[ex.id];
          return {
            weightKg: last ? last.weightKg : '',
            reps: last ? last.reps : '',
            completed: false,
          };
        }),
      })),
      makeCardioEntry('cooldown'),
    ],
  };
}

function makeCardioEntry(kind) {
  return kind === 'warmup'
    ? { exerciseId: 'warmup', exerciseName: 'חימום — הליכה', type: 'cardio', durationSec: 300, startedAt: null, completed: false }
    : { exerciseId: 'cooldown', exerciseName: 'שחרור — הליכה', type: 'cardio', durationSec: 300, startedAt: null, completed: false };
}

function setsForWeek(ex) {
  const week = Math.max(1, Number(settings.programWeek) || 1);
  return Math.max(1, Math.min(week, ex.defaultSets || 1));
}

function applyProgramWeekToActiveSession() {
  if (!activeSession) return;
  activeSession.entries.forEach((entry) => {
    const ex = exercises.find((e) => e.id === entry.exerciseId);
    if (!ex) return;
    const desired = setsForWeek(ex);
    while (entry.sets.length < desired) {
      const last = entry.sets.at(-1);
      entry.sets.push({ weightKg: last ? last.weightKg : '', reps: last ? last.reps : '', completed: false });
    }
    while (entry.sets.length > desired) {
      const last = entry.sets.at(-1);
      if (last.completed) break; // never discard a logged set
      entry.sets.pop();
    }
  });
  persistActiveSession();
  renderWorkoutTab();
}

function getLastCompletedValuesByExercise() {
  const map = {};
  for (let i = workouts.length - 1; i >= 0; i--) {
    const w = workouts[i];
    for (const entry of w.entries) {
      if (map[entry.exerciseId]) continue;
      const lastSet = [...entry.sets].reverse().find((s) => s.completed);
      if (lastSet) map[entry.exerciseId] = { weightKg: lastSet.weightKg, reps: lastSet.reps };
    }
  }
  return map;
}

function wireWorkoutControls() {
  el('btnStartWorkout').addEventListener('click', () => {
    primeSpeech();
    ensureWorkoutStarted();
  });

  el('btnFinishWorkout').addEventListener('click', () => {
    if (!confirm('לסיים ולשמור את האימון?')) return;
    finishWorkout();
  });

  el('btnCancelWorkout').addEventListener('click', cancelWorkout);

  el('btnSkipRest').addEventListener('click', () => {
    restTimer.stop();
    el('restOverlay').classList.add('hidden');
  });
  el('btnRestAdd15').addEventListener('click', () => restTimer.addSeconds(15));
}

// Starts the overall workout stopwatch the moment ANY activity begins (warm-up,
// a set, etc.) so history always reflects the true total workout duration.
function ensureWorkoutStarted() {
  if (activeSession.running) return;
  activeSession.running = true;
  activeSession.startedAt = activeSession.startedAt || new Date().toISOString();
  persistActiveSession();
  stopwatch.start(new Date(activeSession.startedAt).getTime());
  requestWakeLock();
  el('btnStartWorkout').classList.add('hidden');
  el('btnFinishWorkout').classList.remove('hidden');
}

// Cancels the current workout without saving anything to history, resetting
// the draft back to a blank session (the opposite of finishWorkout's save path).
function cancelWorkout() {
  if (!confirm('לבטל את האימון הנוכחי ולאפס את כל הנתונים שמולאו? פעולה זו לא ניתנת לביטול.')) return;
  stopwatch.stop();
  activeSession.running = false;
  db.clearActiveSession();
  activeSession = buildDraftSession();
  el('workoutTimerDisplay').textContent = '00:00';
  el('btnStartWorkout').classList.remove('hidden');
  el('btnFinishWorkout').classList.add('hidden');
  renderWorkoutTab();
  showToast('האימון בוטל ואופס 🔄');
}

const CELEBRATION_MESSAGES = [
  'כל הכבוד על האימון וההתקדמות! תמשיך כך 💪',
  'אימון מעולה! עוד צעד קדימה למטרה שלך 🔥',
  'וואו, סיימת את זה! הגוף שלך מודה לך 🙌',
  'יפה מאוד! עקביות היא המפתח — תמשיך ככה 🏆',
  'סיימת חזק! מנוחה טובה ומחר ממשיכים 🚀',
];
function showCelebration() {
  const msg = CELEBRATION_MESSAGES[Math.floor(Math.random() * CELEBRATION_MESSAGES.length)];
  const overlay = document.createElement('div');
  overlay.className = 'celebration-overlay';
  overlay.innerHTML = `<div class="celebration-card"><div class="celebration-emoji">🎉</div><div class="celebration-text">${escapeHtml(msg)}</div></div>`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 5000);
}

function finishWorkout() {
  const durationSec = stopwatch.stop();
  activeSession.running = false;
  activeSession.accumulatedSec = durationSec;

  const hasCompleted = activeSession.entries.some((e) =>
    e.type === 'cardio' ? e.completed : e.sets.some((s) => s.completed)
  );
  if (hasCompleted) {
    const record = {
      id: activeSession.id,
      dateISO: (activeSession.startedAt || new Date().toISOString()),
      finishedAt: new Date().toISOString(),
      durationSec: Math.round(durationSec),
      entries: activeSession.entries
        .map((e) => {
          if (e.type === 'cardio') {
            return e.completed
              ? { exerciseId: e.exerciseId, exerciseName: e.exerciseName, type: 'cardio', durationSec: e.durationSec, completed: true }
              : null;
          }
          return {
            exerciseId: e.exerciseId,
            exerciseName: e.exerciseName,
            sets: e.sets
              .filter((s) => s.completed)
              .map((s) => ({ weightKg: Number(s.weightKg) || 0, reps: Number(s.reps) || 0, completed: true })),
          };
        })
        .filter((e) => e && (e.type === 'cardio' || e.sets.length > 0)),
    };
    workouts.push(record);
    db.saveWorkouts(workouts);
    showToast('האימון נשמר בהיסטוריה ✅');
    showCelebration();
  } else {
    showToast('האימון בוטל (לא הושלם אף סט)');
  }

  db.clearActiveSession();
  activeSession = buildDraftSession();
  el('workoutTimerDisplay').textContent = '00:00';
  el('btnStartWorkout').classList.remove('hidden');
  el('btnFinishWorkout').classList.add('hidden');
  renderWorkoutTab();
  renderHistoryTab();
}

function persistActiveSession() {
  db.saveActiveSession(activeSession);
}

function renderWorkoutTab() {
  const list = el('exerciseList');
  list.innerHTML = '';

  let totalSets = 0, completedSets = 0;
  let exerciseNumber = 0;

  activeSession.entries.forEach((entry) => {
    if (entry.type === 'cardio') {
      list.appendChild(renderCardioCard(entry));
      return;
    }
    const ex = exercises.find((e) => e.id === entry.exerciseId);
    if (!ex) return;
    exerciseNumber += 1;
    totalSets += entry.sets.length;
    completedSets += entry.sets.filter((s) => s.completed).length;

    const card = document.createElement('div');
    card.className = 'exercise-card' + (entry.sets.every((s) => s.completed) ? ' done' : '');

    const head = document.createElement('div');
    head.className = 'exercise-card-head';
    head.innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <span class="exercise-num">${exerciseNumber}</span>
        <div>
          <div class="exercise-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-meta">${ex.inputType === 'hold' ? `החזקה: ${ex.holdSeconds || 15} שניות` : `${escapeHtml(ex.defaultReps)} חזרות`} &middot; ${escapeHtml(ex.notes || '')}</div>
        </div>
      </div>
      <div class="exercise-head-right">
        <span class="exercise-category-tag">${escapeHtml(ex.category)}</span>
        ${ex.images && ex.images.length ? '<button class="btn-photo btnShowPhoto">📷 תמונה</button>' : ''}
      </div>
    `;
    if (ex.images && ex.images.length) {
      qs('.btnShowPhoto', head).addEventListener('click', () => openPhotoModal(ex));
    }
    card.appendChild(head);

    const table = document.createElement('table');
    table.className = 'sets-table';
    const repsHeader = ex.inputType === 'hold' ? 'זמן' : 'חזרות';
    table.innerHTML = `<thead><tr>
        <th>סט</th><th>ק"ג</th><th>lbs</th><th>${repsHeader}</th><th>✓</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    entry.sets.forEach((set, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'set-row' + (set.completed ? ' completed' : '');
      const lbsVal = set.weightKg ? round1(Number(set.weightKg) * KG_TO_LBS) : '';
      const repsCell = ex.inputType === 'hold'
        ? '<td class="hold-cell"></td>'
        : `<td><input type="number" inputmode="numeric" class="set-input reps" value="${set.reps}" placeholder="0"></td>`;
      tr.innerHTML = `
        <td class="set-num">${idx + 1}</td>
        <td><input type="number" inputmode="decimal" class="set-input weight" value="${set.weightKg}" placeholder="0"></td>
        <td><input type="number" inputmode="decimal" class="set-input lbs" value="${lbsVal}" placeholder="0"></td>
        ${repsCell}
        <td><button class="set-check ${set.completed ? 'checked' : ''}" aria-label="סט הושלם"></button></td>
      `;
      const weightInput = qs('.weight', tr);
      const lbsInput = qs('.lbs', tr);
      const checkBtn = qs('.set-check', tr);

      weightInput.addEventListener('input', () => {
        set.weightKg = weightInput.value;
        lbsInput.value = weightInput.value ? round1(Number(weightInput.value) * KG_TO_LBS) : '';
        persistActiveSession();
      });
      lbsInput.addEventListener('input', () => {
        const kgVal = lbsInput.value ? round2(Number(lbsInput.value) / KG_TO_LBS) : '';
        set.weightKg = kgVal;
        weightInput.value = kgVal;
        persistActiveSession();
      });

      if (ex.inputType === 'hold') {
        renderHoldCell(qs('.hold-cell', tr), ex, entry, set, idx, () => {
          checkBtn.classList.add('checked');
          tr.classList.add('completed');
          persistActiveSession();
          updateProgress();
          card.classList.toggle('done', entry.sets.every((s) => s.completed));
          const exerciseDone = entry.sets.every((s) => s.completed);
          startRestTimer(ex, exerciseDone);
        });
      } else {
        const repsInput = qs('.reps', tr);
        repsInput.addEventListener('input', () => {
          set.reps = repsInput.value;
          persistActiveSession();
        });
      }

      checkBtn.addEventListener('click', () => {
        set.completed = !set.completed;
        checkBtn.classList.toggle('checked', set.completed);
        tr.classList.toggle('completed', set.completed);
        persistActiveSession();
        updateProgress();
        card.classList.toggle('done', entry.sets.every((s) => s.completed));
        if (set.completed) {
          ensureWorkoutStarted();
          const exerciseDone = entry.sets.every((s) => s.completed);
          startRestTimer(ex, exerciseDone);
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'set-table-wrap';
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);

    const actions = document.createElement('div');
    actions.className = 'set-row-actions';
    actions.innerHTML = `
      <button class="btn btn-secondary btn-small btnAddSet">+ סט</button>
      <button class="btn btn-secondary btn-small btnRemoveSet">- סט</button>
    `;
    qs('.btnAddSet', actions).addEventListener('click', () => {
      entry.sets.push({ weightKg: entry.sets.at(-1)?.weightKg || '', reps: entry.sets.at(-1)?.reps || '', completed: false });
      persistActiveSession();
      renderWorkoutTab();
    });
    qs('.btnRemoveSet', actions).addEventListener('click', () => {
      if (entry.sets.length <= 1) return;
      entry.sets.pop();
      persistActiveSession();
      renderWorkoutTab();
    });
    card.appendChild(actions);

    list.appendChild(card);
  });

  updateProgress(totalSets, completedSets);
}

function updateProgress(total, done) {
  const strengthEntries = activeSession.entries.filter((e) => e.type !== 'cardio');
  if (total === undefined) {
    total = strengthEntries.reduce((a, e) => a + e.sets.length, 0);
    done = strengthEntries.reduce((a, e) => a + e.sets.filter((s) => s.completed).length, 0);
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  el('setsProgressText').textContent = `${done} / ${total} סטים הושלמו (${pct}%)`;
  el('setsProgressFill').style.width = `${pct}%`;

  const totalEx = strengthEntries.length;
  const doneEx = strengthEntries.filter((e) => e.sets.length && e.sets.every((s) => s.completed)).length;
  const exPct = totalEx ? Math.round((doneEx / totalEx) * 100) : 0;
  el('exProgressText').textContent = `${doneEx} / ${totalEx} תרגילים הושלמו (${exPct}%)`;
  el('exProgressFill').style.width = `${exPct}%`;

  // Overall workout percentage is based on sets completion (the finest-grained measure).
  el('overallProgressBadge').textContent = `${pct}%`;
}

function renderCardioCard(entry) {
  const card = document.createElement('div');
  const isWarmup = entry.exerciseId === 'warmup';
  card.className = 'exercise-card cardio-card' + (entry.completed ? ' done' : '');
  const icon = isWarmup ? '🔥' : '🧘';
  const minutes = Math.round(entry.durationSec / 60);
  card.innerHTML = `
    <div class="exercise-card-head">
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <span class="exercise-num">${icon}</span>
        <div>
          <div class="exercise-name">${escapeHtml(entry.exerciseName)}</div>
          <div class="exercise-meta">הליכה ${minutes} דקות</div>
        </div>
      </div>
    </div>
    <div class="cardio-body">
      <div class="cardio-timer-display" id="cardio-remaining-${entry.exerciseId}">${formatHMS(entry.startedAt ? Math.max(0, entry.durationSec - (Date.now() - entry.startedAt) / 1000) : entry.durationSec)}</div>
      <div class="settings-actions">
        <button class="btn btn-secondary btn-small btnCardioStart">${entry.startedAt && !entry.completed ? '⏸ עצור' : '▶ התחל'}</button>
        <button class="btn btn-secondary btn-small btnCardioReset">↺ איפוס</button>
        <button class="btn btn-small ${entry.completed ? 'btn-primary' : 'btn-secondary'} btnCardioDone">${entry.completed ? '✓ בוצע' : 'סמן כבוצע'}</button>
      </div>
    </div>
  `;
  qs('.btnCardioStart', card).addEventListener('click', () => {
    if (entry.startedAt && !entry.completed) {
      // pause: bank the elapsed time by shrinking the remaining duration
      const elapsed = (Date.now() - entry.startedAt) / 1000;
      entry.durationSec = Math.max(0, entry.durationSec - elapsed);
      entry.startedAt = null;
    } else {
      ensureWorkoutStarted();
      entry.completed = false;
      entry.startedAt = Date.now();
    }
    persistActiveSession();
    renderWorkoutTab();
  });
  qs('.btnCardioReset', card).addEventListener('click', () => {
    entry.durationSec = 300;
    entry.startedAt = null;
    entry.completed = false;
    persistActiveSession();
    renderWorkoutTab();
  });
  qs('.btnCardioDone', card).addEventListener('click', () => {
    entry.completed = !entry.completed;
    entry.startedAt = null;
    persistActiveSession();
    renderWorkoutTab();
  });
  return card;
}

function tickCardioTimers() {
  if (!activeSession) return;
  let needsRerender = false;
  activeSession.entries.forEach((entry) => {
    if (entry.type !== 'cardio' || !entry.startedAt || entry.completed) return;
    const remaining = entry.durationSec - (Date.now() - entry.startedAt) / 1000;
    const span = el(`cardio-remaining-${entry.exerciseId}`);
    if (remaining <= 0) {
      entry.completed = true;
      entry.startedAt = null;
      persistActiveSession();
      playBeep();
      const msg = entry.exerciseId === 'warmup' ? 'החימום הסתיים' : 'השחרור הסתיים';
      if (settings.voiceAnnouncements) speak(msg);
      showToast(`${msg} ✅`);
      notify('AutoFit', msg);
      needsRerender = true;
    } else if (span) {
      span.textContent = formatHMS(remaining);
    }
  });
  if (needsRerender) renderWorkoutTab();
}

/* ---- hold-type (e.g. plank) per-set timer: start -> counts up -> beeps/announces at
   the target duration so the trainee knows when to stop -> stop records the achieved
   duration, auto-checks the set, and kicks off the normal rest timer for the next rep ---- */
function startHoldTicking(display, startedAt, target) {
  return setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    display.textContent = formatHMS(elapsed);
    if (elapsed >= target && !display.classList.contains('reached')) {
      display.classList.add('reached');
      playBeep();
      if (settings.voiceAnnouncements) speak(`${target} שניות הושלמו, אפשר לעצור`);
      notify('AutoFit', `${target} שניות הושלמו — אפשר לעצור`);
    }
  }, 250);
}
function renderHoldCell(td, ex, entry, set, idx, onAutoComplete) {
  const key = `${entry.exerciseId}:${idx}`;
  if (set.completed) {
    const state = holdTimers.get(key);
    if (state) { clearInterval(state.intervalId); holdTimers.delete(key); }
    td.innerHTML = `<div class="hold-timer-cell"><span class="hold-result">${escapeHtml(String(set.reps || ex.holdSeconds || 15))} שנ'</span><button class="hold-reset" title="מדוד שוב">↺</button></div>`;
    qs('.hold-reset', td).addEventListener('click', () => {
      set.completed = false;
      set.reps = '';
      persistActiveSession();
      renderWorkoutTab();
    });
    return;
  }
  const target = ex.holdSeconds || 15;
  const existing = holdTimers.get(key);
  const running = !!existing;
  td.innerHTML = `<div class="hold-timer-cell"><span class="hold-timer-display">${running ? formatHMS((Date.now() - existing.startedAt) / 1000) : '0:00'}</span><button class="btn-hold-toggle${running ? ' running' : ''}">${running ? '⏹ עצור' : '▶ התחל'}</button></div>`;
  const display = qs('.hold-timer-display', td);
  const btn = qs('.btn-hold-toggle', td);
  if (existing) {
    clearInterval(existing.intervalId); // old interval pointed at now-detached DOM — rebind to the fresh element
    holdTimers.set(key, { intervalId: startHoldTicking(display, existing.startedAt, target), startedAt: existing.startedAt });
  }
  btn.addEventListener('click', () => {
    const state = holdTimers.get(key);
    if (state) {
      clearInterval(state.intervalId);
      holdTimers.delete(key);
      set.reps = Math.round((Date.now() - state.startedAt) / 1000);
      set.completed = true;
      persistActiveSession();
      onAutoComplete();
      renderWorkoutTab();
    } else {
      ensureWorkoutStarted();
      const startedAt = Date.now();
      holdTimers.set(key, { intervalId: startHoldTicking(display, startedAt, target), startedAt });
      btn.textContent = '⏹ עצור';
      btn.classList.add('running');
    }
  });
}

function startRestTimer(ex, exerciseDone) {
  const seconds = ex.restSeconds || settings.restSeconds || 90;
  el('restExerciseName').textContent = ex.name;
  el('restOverlay').classList.remove('hidden');
  restDoneMessage = exerciseDone ? 'אפשר להמשיך לתרגיל הבא' : 'אפשר להמשיך לסט הבא';
  playBeep();
  if (settings.voiceAnnouncements) speak(exerciseDone ? `${ex.name} הושלם, זמן מנוחה` : 'סט הושלם, זמן מנוחה');
  restTimer.start(seconds);
}

/* ================= HISTORY TAB ================= */
const selectedWorkoutIds = new Set();

function renderHistoryTab() {
  workouts = db.getWorkouts();
  const validIds = new Set(workouts.map((w) => w.id));
  [...selectedWorkoutIds].forEach((id) => { if (!validIds.has(id)) selectedWorkoutIds.delete(id); });
  updateHistorySelectBar();
  const list = el('historyList');
  list.innerHTML = '';
  if (!workouts.length) {
    list.innerHTML = '<p class="exercise-meta">עדיין אין אימונים שמורים. בואו נתחיל! 💪</p>';
    return;
  }
  [...workouts].reverse().forEach((w) => {
    const volume = computeVolume(w);
    const strengthEntries = w.entries.filter((e) => e.type !== 'cardio');
    const totalSets = strengthEntries.reduce((a, e) => a + e.sets.length, 0);
    const totalExercises = strengthEntries.length;
    const item = document.createElement('div');
    item.className = 'history-item' + (selectedWorkoutIds.has(w.id) ? ' selected' : '');
    item.innerHTML = `
      <div class="history-item-top">
        <input type="checkbox" class="history-select-check" ${selectedWorkoutIds.has(w.id) ? 'checked' : ''}>
        <div style="flex:1;">
          <div class="history-date">${formatDate(w.dateISO)}</div>
          <div class="history-sub">
            <span>⏱ ${formatHMS(w.durationSec)}</span>
            <span>🏋️ ${totalExercises} תרגילים</span>
            <span>🧮 ${totalSets} סטים</span>
            <span>📦 ${Math.round(volume)} ק"ג נפח</span>
          </div>
        </div>
        <div style="display:flex;gap:2px;">
          <button class="btn-icon btnEditWorkout">✏️</button>
          <button class="btn-icon btnDeleteWorkout">🗑️</button>
        </div>
      </div>
      <div class="history-detail">
        ${w.entries.map((e) => e.type === 'cardio' ? `
          <div class="history-exercise-line">
            <b>${e.exerciseId === 'warmup' ? '🔥' : '🧘'} ${escapeHtml(e.exerciseName)}</b>
            <div class="history-sets-line"><div>✅ בוצע (${Math.round(e.durationSec / 60)} דקות)</div></div>
          </div>
        ` : `
          <div class="history-exercise-line">
            <b>${escapeHtml(e.exerciseName)}</b>
            <div class="history-sets-line">
              ${e.sets.map((s, i) => `<div>סט ${i + 1}: ${s.weightKg} ק"ג × ${s.reps} חזרות</div>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.btnDeleteWorkout') || ev.target.closest('.btnEditWorkout') || ev.target.closest('.history-select-check')) return;
      item.classList.toggle('open');
    });
    qs('.history-select-check', item).addEventListener('change', (ev) => {
      if (ev.target.checked) selectedWorkoutIds.add(w.id);
      else selectedWorkoutIds.delete(w.id);
      item.classList.toggle('selected', ev.target.checked);
      updateHistorySelectBar();
    });
    qs('.btnEditWorkout', item).addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEditWorkoutModal(w);
    });
    qs('.btnDeleteWorkout', item).addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirm('למחוק את האימון הזה?')) return;
      workouts = workouts.filter((x) => x.id !== w.id);
      db.saveWorkouts(workouts);
      renderHistoryTab();
      renderDashboard();
    });
    list.appendChild(item);
  });
}

function openEditWorkoutModal(workout) {
  const clone = JSON.parse(JSON.stringify(workout));
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-modal">
      <div class="photo-modal-head"><b>עריכת אימון — ${formatDate(clone.dateISO)}</b><button class="btn-icon btnCloseEditW">✕</button></div>
      <div class="edit-workout-body">
        ${clone.entries.map((e, ei) => e.type === 'cardio' ? `
          <div class="edit-exercise-block">
            <div class="edit-exercise-title">${e.exerciseId === 'warmup' ? '🔥' : '🧘'} ${escapeHtml(e.exerciseName)} — ✅ בוצע</div>
          </div>
        ` : `
          <div class="edit-exercise-block" data-ei="${ei}">
            <div class="edit-exercise-title">${escapeHtml(e.exerciseName)}</div>
            ${e.sets.map((s, si) => `
              <div class="edit-set-row" data-si="${si}">
                <span class="set-num">סט ${si + 1}</span>
                <input type="number" inputmode="decimal" class="input edit-weight" value="${s.weightKg}" placeholder="ק&quot;ג">
                <input type="number" inputmode="numeric" class="input edit-reps" value="${s.reps}" placeholder="חזרות">
                <button class="btn-icon btnDeleteEditSet">🗑️</button>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary btnSaveEditW">שמור שינויים</button>
        <button class="btn btn-secondary btnCancelEditW">ביטול</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  qs('.btnCloseEditW', overlay).addEventListener('click', close);
  qs('.btnCancelEditW', overlay).addEventListener('click', close);
  qsa('.btnDeleteEditSet', overlay).forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.edit-set-row').remove());
  });
  qs('.btnSaveEditW', overlay).addEventListener('click', () => {
    qsa('.edit-exercise-block[data-ei]', overlay).forEach((block) => {
      const ei = Number(block.dataset.ei);
      const rows = qsa('.edit-set-row', block);
      clone.entries[ei].sets = rows.map((row) => ({
        weightKg: Number(qs('.edit-weight', row).value) || 0,
        reps: Number(qs('.edit-reps', row).value) || 0,
        completed: true,
      }));
    });
    clone.entries = clone.entries.filter((e) => e.type === 'cardio' || e.sets.length > 0);
    workouts = db.getWorkouts().map((w) => (w.id === clone.id ? clone : w));
    db.saveWorkouts(workouts);
    close();
    renderHistoryTab();
    renderDashboard();
    showToast('האימון עודכן ✅');
  });
}

/* ---------------- share workout(s) (email / WhatsApp / PDF / image) ---------------- */
function buildWorkoutShareLines(workoutsArr) {
  const who = profile && profile.name ? ` — ${profile.name}` : '';
  const lines = [];
  if (workoutsArr.length > 1) {
    const totalVolume = workoutsArr.reduce((a, w) => a + computeVolume(w), 0);
    lines.push(`💪 ${workoutsArr.length} אימוני AutoFit${who}`);
    lines.push(`📦 נפח מצטבר: ${Math.round(totalVolume).toLocaleString()} ק"ג`);
    lines.push('');
  }
  workoutsArr.forEach((w, wi) => {
    if (workoutsArr.length > 1) lines.push(`━━━ אימון ${wi + 1} ━━━`);
    else lines.push(`💪 אימון AutoFit${who}`);
    lines.push(`📅 ${formatDate(w.dateISO)}`);
    lines.push(`⏱ משך האימון: ${formatHMS(w.durationSec)}`);
    lines.push(`📦 נפח: ${Math.round(computeVolume(w)).toLocaleString()} ק"ג`);
    lines.push('');
    w.entries.forEach((e) => {
      if (e.type === 'cardio') {
        if (e.completed) lines.push(`${e.exerciseId === 'warmup' ? '🔥 חימום' : '🧘 שחרור'}: ${Math.round(e.durationSec / 60)} דקות`);
        return;
      }
      if (!e.sets.length) return;
      lines.push(`🏋️ ${e.exerciseName}`);
      e.sets.forEach((s, i) => lines.push(`   סט ${i + 1}: ${s.weightKg} ק"ג × ${s.reps}`));
    });
    lines.push('');
  });
  lines.push('נשלח מתוך AutoFit 🚀');
  return lines;
}

function buildWorkoutShareText(workoutsArr) {
  return buildWorkoutShareLines(workoutsArr).join('\n');
}

// Renders the same summary onto a canvas and returns a PNG Blob. Sharing an image
// is far more reliable for WhatsApp (and most share targets) than a generated PDF,
// and fully supports Hebrew/RTL since the canvas handles text shaping natively.
function buildWorkoutShareImage(workoutsArr) {
  return new Promise((resolve) => {
    const lines = buildWorkoutShareLines(workoutsArr);
    const width = 720;
    const lineHeight = 30;
    const topPadding = 90;
    const height = topPadding + lines.length * lineHeight + 30;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, width, height);
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.fillText('💪 AutoFit', width - 24, 48);
    ctx.font = '16px Arial';
    ctx.fillStyle = '#cbd5e1';
    let y = topPadding;
    lines.forEach((line) => {
      ctx.fillText(line, width - 24, y);
      y += lineHeight;
    });
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

function openWorkoutPrintView(workoutsArr) {
  const who = profile && profile.name ? escapeHtml(profile.name) : '';
  const win = window.open('', '_blank');
  if (!win) { showToast('הדפדפן חסם פתיחת חלון — אפשר לנסות שוב'); return; }
  const sections = workoutsArr.map((w) => {
    const rows = w.entries.map((e) => {
      if (e.type === 'cardio') {
        return e.completed
          ? `<div class="pw-ex"><b>${e.exerciseId === 'warmup' ? '🔥 חימום' : '🧘 שחרור'}</b> — ${Math.round(e.durationSec / 60)} דקות</div>`
          : '';
      }
      if (!e.sets.length) return '';
      return `<div class="pw-ex"><b>${escapeHtml(e.exerciseName)}</b>
        <table><thead><tr><th>סט</th><th>ק"ג</th><th>חזרות</th></tr></thead>
        <tbody>${e.sets.map((s, i) => `<tr><td>${i + 1}</td><td>${s.weightKg}</td><td>${s.reps}</td></tr>`).join('')}</tbody>
        </table></div>`;
    }).join('');
    return `<section class="pw-section">
      <div class="pw-sub">${formatDate(w.dateISO)} &middot; משך: ${formatHMS(w.durationSec)}</div>
      <div class="pw-stats"><span>📦 נפח: ${Math.round(computeVolume(w)).toLocaleString()} ק"ג</span></div>
      ${rows}
    </section>`;
  }).join('<div class="pw-divider"></div>');
  const title = workoutsArr.length > 1 ? `${workoutsArr.length} אימוני AutoFit` : `אימון AutoFit — ${formatDate(workoutsArr[0].dateISO)}`;
  win.document.write(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
    <title>${title}</title>
    <style>
      body{font-family:Arial, Helvetica, sans-serif; padding:24px; color:#111;}
      h1{text-align:center; margin-bottom:4px;}
      .pw-sub{text-align:center; color:#555; margin-bottom:20px;}
      .pw-stats{display:flex; justify-content:center; gap:18px; margin-bottom:24px; flex-wrap:wrap;}
      .pw-stats span{background:#f1f1f1; padding:6px 12px; border-radius:8px;}
      .pw-ex{margin-bottom:14px; page-break-inside:avoid;}
      .pw-section{margin-bottom:10px;}
      .pw-divider{border-top:2px dashed #ccc; margin:24px 0; page-break-after:always;}
      table{width:100%; border-collapse:collapse; margin-top:4px;}
      th,td{border:1px solid #ccc; padding:4px 8px; text-align:center;}
      .pw-footer{text-align:center; margin-top:30px; color:#888; font-size:12px;}
    </style></head><body>
    <h1>💪 AutoFit${who ? ' — ' + who : ''}</h1>
    ${sections}
    <div class="pw-footer">נוצר באפליקציית AutoFit</div>
    <script>window.onload = () => setTimeout(() => window.print(), 300);</script>
    </body></html>`);
  win.document.close();
}

function openShareModal(workoutsArr) {
  const list = Array.isArray(workoutsArr) ? workoutsArr : [workoutsArr];
  const text = buildWorkoutShareText(list);
  const title = list.length > 1 ? `שיתוף ${list.length} אימונים` : `שיתוף אימון — ${formatDate(list[0].dateISO)}`;
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-modal">
      <div class="photo-modal-head"><b>${title}</b><button class="btn-icon btnCloseShare">✕</button></div>
      <div class="settings-actions" style="flex-direction:column;">
        ${navigator.share ? '<button class="btn btn-primary" id="shareNative">📲 שתף (מייל / וואטסאפ / ועוד)</button>' : ''}
        <button class="btn btn-secondary" id="shareImage">🖼️ שתף כתמונה (מומלץ לוואטסאפ)</button>
        <button class="btn btn-secondary" id="shareMail">📧 שליחה במייל</button>
        <button class="btn btn-secondary" id="shareWhatsapp">💬 שליחה בוואטסאפ (טקסט)</button>
        <button class="btn btn-secondary" id="sharePdf">🖨️ ייצוא כ-PDF (הדפסה/שמירה)</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  qs('.btnCloseShare', overlay).addEventListener('click', close);
  if (navigator.share) {
    qs('#shareNative', overlay).addEventListener('click', async () => {
      try { await navigator.share({ title: 'אימון AutoFit', text }); close(); } catch (e) { /* user cancelled */ }
    });
  }
  qs('#shareImage', overlay).addEventListener('click', async () => {
    const blob = await buildWorkoutShareImage(list);
    if (!blob) { showToast('יצירת התמונה נכשלה, נסה שוב'); return; }
    const file = new File([blob], `autofit-${Date.now()}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'אימון AutoFit' }); close(); return; } catch (e) { /* user cancelled */ return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast('התמונה הורדה — אפשר לשתף אותה מהגלריה/קבצים בוואטסאפ');
    close();
  });
  qs('#shareMail', overlay).addEventListener('click', () => {
    const subject = encodeURIComponent(title);
    window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`;
    close();
  });
  qs('#shareWhatsapp', overlay).addEventListener('click', () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    close();
  });
  qs('#sharePdf', overlay).addEventListener('click', () => {
    openWorkoutPrintView(list);
    close();
  });
}

function updateHistorySelectBar() {
  const n = selectedWorkoutIds.size;
  el('historySelectCount').textContent = `${n} נבחרו`;
}

function wireHistoryTab() {
  el('btnShareSelected').addEventListener('click', () => {
    const selected = workouts.filter((w) => selectedWorkoutIds.has(w.id))
      .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
    if (!selected.length) {
      showToast('בחר לפחות אימון אחד מההיסטוריה כדי לשתף ✅');
      return;
    }
    openShareModal(selected);
  });
  el('btnClearSelection').addEventListener('click', () => {
    selectedWorkoutIds.clear();
    renderHistoryTab();
  });
}

function computeVolume(workout) {
  return workout.entries.reduce((sum, e) => {
    if (e.type === 'cardio' || !e.sets) return sum;
    return sum + e.sets.reduce((s2, s) => s2 + (s.weightKg * s.reps), 0);
  }, 0);
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

/* ================= DASHBOARD TAB ================= */
let volumeChartInstance = null;
let exerciseChartInstance = null;
let consistencyChartInstance = null;

function renderDashboard() {
  workouts = db.getWorkouts();
  renderStatsGrid();
  renderVolumeChart();
  renderExercisePicker();
  renderConsistencyChart();
}

function renderStatsGrid() {
  const grid = el('statsGrid');
  const totalWorkouts = workouts.length;
  const totalVolume = workouts.reduce((a, w) => a + computeVolume(w), 0);
  const avgDuration = totalWorkouts ? workouts.reduce((a, w) => a + w.durationSec, 0) / totalWorkouts : 0;
  const streak = computeStreak();
  const weekCount = countThisWeek();

  const stats = [
    { label: 'שבוע תוכנית נוכחי', value: settings.programWeek || 1 },
    { label: 'סה"כ אימונים', value: totalWorkouts },
    { label: 'נפח כולל (ק"ג)', value: Math.round(totalVolume).toLocaleString() },
    { label: 'זמן ממוצע', value: formatHMS(avgDuration) },
    { label: 'רצף שבועות', value: streak },
    { label: `השבוע (יעד ${settings.weeklyGoal})`, value: `${weekCount}/${settings.weeklyGoal}` },
    { label: 'סטים כולל', value: workouts.reduce((a, w) => a + w.entries.reduce((b, e) => b + (e.type === 'cardio' ? 0 : e.sets.length), 0), 0) },
  ];
  grid.innerHTML = stats.map((s) => `
    <div class="stat-box"><div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div></div>
  `).join('');
}

function computeStreak() {
  // consecutive weeks (ISO week) with at least one workout, counting back from current week
  if (!workouts.length) return 0;
  const weeksWithWorkout = new Set(workouts.map((w) => isoWeekKey(new Date(w.dateISO))));
  let streak = 0;
  let cursor = new Date();
  while (true) {
    const key = isoWeekKey(cursor);
    if (weeksWithWorkout.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 7);
    } else break;
  }
  return streak;
}
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}
function countThisWeek() {
  const now = new Date();
  const key = isoWeekKey(now);
  return workouts.filter((w) => isoWeekKey(new Date(w.dateISO)) === key).length;
}

function renderVolumeChart() {
  if (!window.Chart) return;
  const ctx = el('volumeChart');
  const sorted = [...workouts].sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  const labels = sorted.map((w) => new Date(w.dateISO).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }));
  const data = sorted.map((w) => Math.round(computeVolume(w)));

  if (volumeChartInstance) volumeChartInstance.destroy();
  volumeChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'נפח (ק"ג)', data, backgroundColor: '#2563eb' }] },
    options: chartBaseOptions(),
  });
}

function renderExercisePicker() {
  const select = el('exercisePickerChart');
  const prev = select.value;
  select.innerHTML = exercises.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  if (prev && exercises.some((e) => e.id === prev)) select.value = prev;
  select.onchange = renderExerciseChart;
  renderExerciseChart();
}

function renderExerciseChart() {
  if (!window.Chart) return;
  const exId = el('exercisePickerChart').value;
  const ctx = el('exerciseChart');
  const points = [];
  [...workouts].sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO)).forEach((w) => {
    const entry = w.entries.find((e) => e.exerciseId === exId);
    if (!entry || !entry.sets.length) return;
    const maxWeight = Math.max(...entry.sets.map((s) => s.weightKg));
    points.push({ date: new Date(w.dateISO).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }), maxWeight });
  });
  if (exerciseChartInstance) exerciseChartInstance.destroy();
  exerciseChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map((p) => p.date),
      datasets: [{ label: 'משקל מקסימלי (ק"ג)', data: points.map((p) => p.maxWeight), borderColor: '#22c55e', backgroundColor: '#22c55e33', tension: 0.3, fill: true }],
    },
    options: chartBaseOptions(),
  });
}

function renderConsistencyChart() {
  if (!window.Chart) return;
  const ctx = el('consistencyChart');
  const weeks = [];
  const counts = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = isoWeekKey(d);
    weeks.push(key.replace(/^\d+-/, ''));
    counts.push(workouts.filter((w) => isoWeekKey(new Date(w.dateISO)) === key).length);
  }
  if (consistencyChartInstance) consistencyChartInstance.destroy();
  consistencyChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: weeks, datasets: [{ label: 'אימונים בשבוע', data: counts, backgroundColor: counts.map((c) => c >= settings.weeklyGoal ? '#16a34a' : '#eab308') }] },
    options: chartBaseOptions(),
  });
}

function chartBaseOptions() {
  return {
    responsive: true,
    plugins: { legend: { labels: { color: '#c8ccd8' } } },
    scales: {
      x: { ticks: { color: '#9aa0ad' }, grid: { color: '#20232e' } },
      y: { ticks: { color: '#9aa0ad' }, grid: { color: '#20232e' }, beginAtZero: true },
    },
  };
}

/* ================= EXERCISES TAB ================= */
function wireExercisesTab() {
  el('btnAddExercise').addEventListener('click', () => {
    const draft = { id: db.uid(), name: '', category: 'כללי', defaultSets: 3, defaultReps: '12-15', restSeconds: 120, notes: '', images: [], active: true };
    openExerciseEditModal(draft, { isNew: true });
  });
}

function renderExercisesTab() {
  const list = el('exerciseManageList');
  list.innerHTML = '';
  exercises.forEach((ex) => {
    const item = document.createElement('div');
    item.className = 'exercise-manage-item sortable-item' + (ex.active === false ? ' inactive' : '');
    item.dataset.id = ex.id;
    item.innerHTML = `
      <div class="exercise-manage-head">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="drag-handle" title="גרור לשינוי סדר">⠿</span>
          <div>
            <b>${escapeHtml(ex.name)}</b>
            <div class="exercise-meta">${escapeHtml(ex.category)} &middot; ${ex.defaultSets} סטים × ${escapeHtml(ex.defaultReps)}</div>
            <label class="checkbox-row ex-active-toggle"><input type="checkbox" class="exActiveCheck" ${ex.active !== false ? 'checked' : ''}> כלול באימון</label>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          ${ex.images && ex.images.length ? '<button class="btn-icon btnShowPhotoManage">📷</button>' : ''}
          <button class="btn-icon btnEditEx">✏️</button>
          <button class="btn-icon btnDeleteEx">🗑️</button>
        </div>
      </div>
    `;
    qs('.btnEditEx', item).addEventListener('click', () => openExerciseEditModal(ex));
    qs('.btnDeleteEx', item).addEventListener('click', () => {
      if (!confirm(`למחוק את "${ex.name}"? אימוני עבר יישמרו.`)) return;
      exercises = exercises.filter((e) => e.id !== ex.id);
      db.saveExercises(exercises);
      renderExercisesTab();
      reorderActiveSessionToMatchExercises();
    });
    qs('.exActiveCheck', item).addEventListener('change', (e) => {
      ex.active = e.target.checked;
      db.saveExercises(exercises);
      renderExercisesTab();
      reorderActiveSessionToMatchExercises();
      showToast(ex.active ? `"${ex.name}" ייכלל באימונים הבאים` : `"${ex.name}" לא ייכלל באימונים הבאים (נשאר שמור)`);
    });
    const photoBtnManage = qs('.btnShowPhotoManage', item);
    if (photoBtnManage) photoBtnManage.addEventListener('click', () => openPhotoModal(ex));
    list.appendChild(item);
  });
  makeSortable(list, (newOrderIds) => {
    const byId = Object.fromEntries(exercises.map((e) => [e.id, e]));
    exercises = newOrderIds.map((id) => byId[id]).filter(Boolean);
    db.saveExercises(exercises);
    reorderActiveSessionToMatchExercises();
  });
}

/* ---- image upload helper: downsizes to keep localStorage small ---- */
function fileToResizedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 800;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openExerciseEditModal(ex, options = {}) {
  const isNew = !!options.isNew;
  let currentImages = [...(ex.images || [])];
  let inputType = ex.inputType || 'reps';
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-modal">
      <div class="photo-modal-head"><b>${isNew ? 'תרגיל חדש' : 'עריכת תרגיל'}</b><button class="btn-icon btnCloseExEdit">✕</button></div>
      <label class="field-label">שם התרגיל</label>
      <input class="input" id="editExName" value="${escapeAttr(ex.name)}" placeholder="שם התרגיל">
      <label class="field-label">קבוצת שריר</label>
      <input class="input" id="editExCategory" value="${escapeAttr(ex.category)}">
      <label class="field-label">סטים ברירת מחדל</label>
      <input type="number" min="1" class="input" id="editExSets" value="${ex.defaultSets}">
      <label class="field-label">סוג מדידה</label>
      <select class="select" id="editExInputType">
        <option value="reps" ${inputType === 'reps' ? 'selected' : ''}>חזרות</option>
        <option value="hold" ${inputType === 'hold' ? 'selected' : ''}>החזקה בזמן (שניות)</option>
      </select>
      <div id="editExRepsWrap">
        <label class="field-label">חזרות</label>
        <input class="input" id="editExReps" value="${escapeAttr(ex.defaultReps)}">
      </div>
      <div id="editExHoldWrap" class="hidden">
        <label class="field-label">זמן יעד להחזקה (שניות)</label>
        <input type="number" min="1" class="input" id="editExHoldSeconds" value="${ex.holdSeconds || 15}">
      </div>
      <label class="field-label">מנוחה (שניות)</label>
      <input type="number" min="10" class="input" id="editExRest" value="${ex.restSeconds}">
      <label class="field-label">הערות</label>
      <input class="input" id="editExNotes" value="${escapeAttr(ex.notes || '')}">
      <label class="checkbox-row"><input type="checkbox" id="editExActive" ${ex.active !== false ? 'checked' : ''}> כלול באימונים הבאים</label>

      <label class="field-label">תמונות</label>
      <div class="image-manage-grid" id="editExImageGrid"></div>
      <input type="file" accept="image/*" id="editExImageInput" class="hidden">
      <div class="settings-actions">
        <button class="btn btn-secondary btn-small" id="btnAddExImage">📷 העלה תמונה</button>
      </div>

      <div class="settings-actions">
        <button class="btn btn-primary" id="btnSaveExEdit">שמור</button>
        <button class="btn btn-secondary" id="btnCancelExEdit">ביטול</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function renderImageGrid() {
    const grid = qs('#editExImageGrid', overlay);
    grid.innerHTML = currentImages.map((src, i) => `
      <div class="image-manage-thumb"><img src="${src}"><button class="btnRemoveImg" data-i="${i}">✕</button></div>
    `).join('') || '<div class="exercise-meta">אין תמונות עדיין</div>';
    qsa('.btnRemoveImg', grid).forEach((btn) => {
      btn.addEventListener('click', () => {
        currentImages.splice(Number(btn.dataset.i), 1);
        renderImageGrid();
      });
    });
  }
  renderImageGrid();

  qs('#editExInputType', overlay).addEventListener('change', (e) => {
    inputType = e.target.value;
    qs('#editExRepsWrap', overlay).classList.toggle('hidden', inputType === 'hold');
    qs('#editExHoldWrap', overlay).classList.toggle('hidden', inputType !== 'hold');
  });
  qs('#editExInputType', overlay).dispatchEvent(new Event('change'));

  qs('#btnAddExImage', overlay).addEventListener('click', () => qs('#editExImageInput', overlay).click());
  qs('#editExImageInput', overlay).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      currentImages.push(dataUrl);
      renderImageGrid();
    } catch (err) {
      showToast('לא ניתן לטעון את התמונה');
    }
    e.target.value = '';
  });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  qs('.btnCloseExEdit', overlay).addEventListener('click', close);
  qs('#btnCancelExEdit', overlay).addEventListener('click', close);
  qs('#btnSaveExEdit', overlay).addEventListener('click', () => {
    const name = qs('#editExName', overlay).value.trim();
    if (!name) { showToast('נא להזין שם לתרגיל'); return; }
    ex.name = name;
    ex.category = qs('#editExCategory', overlay).value.trim() || ex.category || 'כללי';
    ex.defaultSets = Math.max(1, Number(qs('#editExSets', overlay).value) || 1);
    ex.inputType = inputType === 'hold' ? 'hold' : 'reps';
    if (ex.inputType === 'hold') {
      ex.holdSeconds = Math.max(1, Number(qs('#editExHoldSeconds', overlay).value) || 15);
      ex.defaultReps = `${ex.holdSeconds} שניות החזקה`;
    } else {
      delete ex.holdSeconds;
      ex.defaultReps = qs('#editExReps', overlay).value.trim();
    }
    ex.restSeconds = Math.max(10, Number(qs('#editExRest', overlay).value) || 90);
    ex.notes = qs('#editExNotes', overlay).value.trim();
    ex.active = qs('#editExActive', overlay).checked;
    ex.images = currentImages;
    if (isNew) {
      exercises.push(ex);
    }
    db.saveExercises(exercises);
    syncExerciseNameEverywhere(ex);
    renderExercisesTab();
    reorderActiveSessionToMatchExercises();
    close();
    showToast(isNew ? 'התרגיל נוסף ✅' : 'התרגיל נשמר ✅');
  });
}

function syncExerciseNameEverywhere(ex) {
  if (!activeSession) return;
  let changed = false;
  activeSession.entries.forEach((e) => {
    if (e.exerciseId === ex.id && e.exerciseName !== ex.name) {
      e.exerciseName = ex.name;
      changed = true;
    }
  });
  if (changed) {
    persistActiveSession();
    renderWorkoutTab();
  }
}

/* ---- drag-to-reorder (pointer events, touch-friendly for iPhone) ---- */
function makeSortable(listEl, onReorder) {
  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const dragEl = handle.closest('.sortable-item');
    if (!dragEl) return;
    e.preventDefault();
    dragEl.setPointerCapture(e.pointerId);
    dragEl.classList.add('dragging');

    const onMove = (ev) => {
      const y = ev.clientY;
      const siblings = qsa('.sortable-item', listEl).filter((s) => s !== dragEl);
      let next = null;
      for (const sib of siblings) {
        const rect = sib.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { next = sib; break; }
      }
      if (next) listEl.insertBefore(dragEl, next);
      else listEl.appendChild(dragEl);
    };
    const onUp = () => {
      dragEl.classList.remove('dragging');
      try { dragEl.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const newOrder = qsa('.sortable-item', listEl).map((x) => x.dataset.id);
      onReorder(newOrder);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function reorderActiveSessionToMatchExercises() {
  if (!activeSession) return;
  const warmup = activeSession.entries.find((e) => e.exerciseId === 'warmup');
  const cooldown = activeSession.entries.find((e) => e.exerciseId === 'cooldown');
  const byExId = Object.fromEntries(activeSession.entries.map((e) => [e.exerciseId, e]));
  const hasProgress = activeSession.entries.some((e) => e.type !== 'cardio' && e.sets.some((s) => s.completed));

  if (hasProgress) {
    // mid-workout: never drop logged data — just reorder to match the exercise list,
    // keeping any already-logged entries (even now-inactive/deleted ones) at the end.
    const reordered = exercises.map((ex) => byExId[ex.id]).filter(Boolean);
    const orphan = activeSession.entries.filter((e) =>
      e.exerciseId !== 'warmup' && e.exerciseId !== 'cooldown' && !exercises.some((ex) => ex.id === e.exerciseId));
    activeSession.entries = [warmup, ...reordered, ...orphan, cooldown].filter(Boolean);
  } else {
    // fresh draft: fully sync to the currently-active exercise list (add new, drop deselected)
    const lastByExercise = getLastCompletedValuesByExercise();
    const synced = exercises.filter((ex) => ex.active !== false).map((ex) => {
      if (byExId[ex.id]) return byExId[ex.id];
      const last = lastByExercise[ex.id];
      return {
        exerciseId: ex.id,
        exerciseName: ex.name,
        sets: Array.from({ length: setsForWeek(ex) }, () => ({ weightKg: last ? last.weightKg : '', reps: last ? last.reps : '', completed: false })),
      };
    });
    activeSession.entries = [warmup, ...synced, cooldown].filter(Boolean);
  }
  persistActiveSession();
  renderWorkoutTab();
}

/* ---- photo modal ---- */
function openPhotoModal(ex) {
  if (!ex.images || !ex.images.length) { showToast('אין תמונה לתרגיל זה'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'photo-overlay';
  overlay.innerHTML = `
    <div class="photo-modal">
      <div class="photo-modal-head"><b>${escapeHtml(ex.name)}</b><button class="btn-icon btnClosePhoto">✕</button></div>
      <div class="photo-grid">
        ${ex.images.map((src) => `<img src="${src}" alt="${escapeAttr(ex.name)}" loading="lazy">`).join('')}
      </div>
      ${ex.images.length > 1 ? '<div class="photo-caption">יש כמה אפשרויות ביצוע — בחרו לפי מה שזמין באולם</div>' : ''}
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  qs('.btnClosePhoto', overlay).addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

/* ================= SETTINGS TAB ================= */
function wireSettings() {
  el('settingRestSeconds').addEventListener('change', (e) => {
    settings.restSeconds = Math.max(10, Number(e.target.value) || 90);
    db.saveSettings(settings);
  });
  el('settingWeeklyGoal').addEventListener('change', (e) => {
    settings.weeklyGoal = Math.max(1, Number(e.target.value) || 3);
    db.saveSettings(settings);
  });
  el('settingProgramWeek').addEventListener('change', (e) => {
    settings.programWeek = Math.max(1, Number(e.target.value) || 1);
    db.saveSettings(settings);
    applyProgramWeekToActiveSession();
    showToast(`שבוע תוכנית עודכן ל-${settings.programWeek}`);
  });
  el('settingVoice').addEventListener('change', (e) => {
    settings.voiceAnnouncements = e.target.checked;
    db.saveSettings(settings);
    if (settings.voiceAnnouncements) { primeSpeech(); speak('ההודעות הקוליות הופעלו'); }
  });
  el('btnExportData').addEventListener('click', () => {
    const data = db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitness-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  el('btnImportData').addEventListener('click', () => el('importFileInput').click());
  el('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        db.importAll(data);
        showToast('הייבוא הושלם — טוען מחדש...');
        setTimeout(() => location.reload(), 1000);
      } catch (err) {
        alert('קובץ לא תקין');
      }
    };
    reader.readAsText(file);
  });
  el('btnResetAll').addEventListener('click', () => {
    if (!confirm('פעולה זו תמחק את כל הנתונים לצמיתות. להמשיך?')) return;
    db.resetAll();
    location.reload();
  });
  el('btnEnableNotifications').addEventListener('click', requestNotificationPermission);
}

function renderSettingsTab() {
  el('settingRestSeconds').value = settings.restSeconds;
  el('settingWeeklyGoal').value = settings.weeklyGoal;
  el('settingProgramWeek').value = settings.programWeek || 1;
  el('settingVoice').checked = settings.voiceAnnouncements !== false;
}

/* ================= PERSONAL AREA TAB ================= */
function wireProfileTab() {
  el('btnSaveProfile').addEventListener('click', () => {
    profile.name = el('profileName').value.trim();
    profile.age = el('profileAge').value;
    profile.heightCm = el('profileHeight').value;
    profile.weightKg = el('profileWeight').value;
    db.saveProfile(profile);
    renderBrand();
    showToast('הפרטים האישיים נשמרו ✅');
  });
}
function renderProfileTab() {
  el('profileName').value = profile.name || '';
  el('profileAge').value = profile.age || '';
  el('profileHeight').value = profile.heightCm || '';
  el('profileWeight').value = profile.weightKg || '';
}
function renderBrand() {
  el('appBrand').textContent = profile.name ? `💪 AutoFit — ${profile.name}` : '💪 AutoFit';
}

/* ================= UTIL ================= */
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  // When a newly-deployed service worker takes control, reload once so the
  // freshest HTML/JS/CSS shows up immediately instead of waiting for the user
  // to manually force-quit/reopen the installed app.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

document.addEventListener('DOMContentLoaded', init);

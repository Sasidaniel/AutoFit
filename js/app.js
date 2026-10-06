// app.js — main application controller
import * as db from './db.js';
import { SEED_EXERCISES } from './seed.js';
import { Stopwatch, RestTimer, formatHMS, playBeep } from './timer.js';

const KG_TO_LBS = 2.20462;

/* ---------------- state ---------------- */
let exercises = [];
let settings = db.getSettings();
let activeSession = db.getActiveSession(); // { id, startedAt, accumulatedSec, running, entries: [...] }
let workouts = db.getWorkouts();

const stopwatch = new Stopwatch((elapsed) => {
  el('workoutTimerDisplay').textContent = formatHMS(elapsed);
});
const restTimer = new RestTimer({
  onTick: (remaining) => {
    el('restTimeDisplay').textContent = formatHMS(remaining);
  },
  onDone: () => {
    playBeep();
    el('restOverlay').classList.add('hidden');
    showToast('המנוחה הסתיימה — אפשר לעשות עוד סט! 💪');
  },
});

function el(id) { return document.getElementById(id); }
function qs(sel, parent = document) { return parent.querySelector(sel); }
function qsa(sel, parent = document) { return Array.from(parent.querySelectorAll(sel)); }

/* ---------------- init ---------------- */
function init() {
  exercises = db.getExercises();
  if (!exercises.length) {
    exercises = SEED_EXERCISES.map((e) => ({ id: db.uid(), ...e }));
    db.saveExercises(exercises);
  }
  if (!activeSession) {
    activeSession = buildDraftSession();
  }

  wireTabs();
  wireWorkoutControls();
  wireSettings();
  wireExercisesTab();
  startLiveClock();

  renderWorkoutTab();
  renderHistoryTab();
  renderExercisesTab();
  renderSettingsTab();

  if (activeSession.running) {
    stopwatch.start(activeSession.accumulatedSec || 0);
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
    entries: exercises.map((ex) => ({
      exerciseId: ex.id,
      exerciseName: ex.name,
      sets: Array.from({ length: ex.defaultSets || 1 }, (_, i) => {
        const last = lastByExercise[ex.id];
        return {
          weightKg: last ? last.weightKg : '',
          reps: last ? last.reps : '',
          completed: false,
        };
      }),
    })),
  };
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
    activeSession.running = true;
    activeSession.startedAt = activeSession.startedAt || new Date().toISOString();
    persistActiveSession();
    stopwatch.start(activeSession.accumulatedSec || 0);
    el('btnStartWorkout').classList.add('hidden');
    el('btnFinishWorkout').classList.remove('hidden');
  });

  el('btnFinishWorkout').addEventListener('click', () => {
    if (!confirm('לסיים ולשמור את האימון?')) return;
    finishWorkout();
  });

  el('btnSkipRest').addEventListener('click', () => {
    restTimer.stop();
    el('restOverlay').classList.add('hidden');
  });
  el('btnRestAdd15').addEventListener('click', () => restTimer.addSeconds(15));
}

function finishWorkout() {
  const durationSec = stopwatch.stop();
  activeSession.running = false;
  activeSession.accumulatedSec = durationSec;

  const hasCompleted = activeSession.entries.some((e) => e.sets.some((s) => s.completed));
  if (hasCompleted) {
    const record = {
      id: activeSession.id,
      dateISO: (activeSession.startedAt || new Date().toISOString()),
      finishedAt: new Date().toISOString(),
      durationSec: Math.round(durationSec),
      entries: activeSession.entries.map((e) => ({
        exerciseId: e.exerciseId,
        exerciseName: e.exerciseName,
        sets: e.sets
          .filter((s) => s.completed)
          .map((s) => ({ weightKg: Number(s.weightKg) || 0, reps: Number(s.reps) || 0, completed: true })),
      })).filter((e) => e.sets.length > 0),
    };
    workouts.push(record);
    db.saveWorkouts(workouts);
    showToast('האימון נשמר בהיסטוריה ✅');
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

  activeSession.entries.forEach((entry) => {
    const ex = exercises.find((e) => e.id === entry.exerciseId);
    if (!ex) return;
    totalSets += entry.sets.length;
    completedSets += entry.sets.filter((s) => s.completed).length;

    const card = document.createElement('div');
    card.className = 'exercise-card' + (entry.sets.every((s) => s.completed) ? ' done' : '');

    const head = document.createElement('div');
    head.className = 'exercise-card-head';
    head.innerHTML = `
      <div>
        <div class="exercise-name">${escapeHtml(ex.name)}</div>
        <div class="exercise-meta">${escapeHtml(ex.defaultReps)} חזרות &middot; ${escapeHtml(ex.notes || '')}</div>
      </div>
      <span class="exercise-category-tag">${escapeHtml(ex.category)}</span>
    `;
    card.appendChild(head);

    const table = document.createElement('table');
    table.className = 'sets-table';
    table.innerHTML = `<thead><tr>
        <th></th><th>סט</th><th>ק"ג</th><th>חזרות</th><th>✓</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    entry.sets.forEach((set, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'set-row' + (set.completed ? ' completed' : '');
      const lbs = set.weightKg ? (Number(set.weightKg) * KG_TO_LBS).toFixed(1) : '';
      tr.innerHTML = `
        <td class="set-num">—</td>
        <td class="set-num">${idx + 1}</td>
        <td>
          <input type="number" inputmode="decimal" class="set-input weight" value="${set.weightKg}" placeholder="0">
          <span class="lbs-hint">${lbs ? lbs + ' lbs' : ''}</span>
        </td>
        <td><input type="number" inputmode="numeric" class="set-input reps" value="${set.reps}" placeholder="0"></td>
        <td><button class="set-check ${set.completed ? 'checked' : ''}" aria-label="סט הושלם"></button></td>
      `;
      const weightInput = qs('.weight', tr);
      const repsInput = qs('.reps', tr);
      const checkBtn = qs('.set-check', tr);
      const lbsHint = qs('.lbs-hint', tr);

      weightInput.addEventListener('input', () => {
        set.weightKg = weightInput.value;
        lbsHint.textContent = weightInput.value ? (Number(weightInput.value) * KG_TO_LBS).toFixed(1) + ' lbs' : '';
        persistActiveSession();
      });
      repsInput.addEventListener('input', () => {
        set.reps = repsInput.value;
        persistActiveSession();
      });
      checkBtn.addEventListener('click', () => {
        set.completed = !set.completed;
        checkBtn.classList.toggle('checked', set.completed);
        tr.classList.toggle('completed', set.completed);
        persistActiveSession();
        updateProgress();
        card.classList.toggle('done', entry.sets.every((s) => s.completed));
        if (set.completed) {
          if (!activeSession.running) el('btnStartWorkout').click();
          startRestTimer(ex);
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);

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
  if (total === undefined) {
    total = activeSession.entries.reduce((a, e) => a + e.sets.length, 0);
    done = activeSession.entries.reduce((a, e) => a + e.sets.filter((s) => s.completed).length, 0);
  }
  el('setsProgressText').textContent = `${done} / ${total} סטים הושלמו`;
  el('setsProgressFill').style.width = total ? `${(done / total) * 100}%` : '0%';
}

function startRestTimer(ex) {
  const seconds = ex.restSeconds || settings.restSeconds || 90;
  el('restExerciseName').textContent = ex.name;
  el('restOverlay').classList.remove('hidden');
  restTimer.start(seconds);
}

/* ================= HISTORY TAB ================= */
function renderHistoryTab() {
  workouts = db.getWorkouts();
  const list = el('historyList');
  list.innerHTML = '';
  if (!workouts.length) {
    list.innerHTML = '<p class="exercise-meta">עדיין אין אימונים שמורים. בואו נתחיל! 💪</p>';
    return;
  }
  [...workouts].reverse().forEach((w) => {
    const volume = computeVolume(w);
    const totalSets = w.entries.reduce((a, e) => a + e.sets.length, 0);
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item-top">
        <div>
          <div class="history-date">${formatDate(w.dateISO)}</div>
          <div class="history-sub">
            <span>⏱ ${formatHMS(w.durationSec)}</span>
            <span>🧮 ${totalSets} סטים</span>
            <span>📦 ${Math.round(volume)} ק"ג נפח</span>
          </div>
        </div>
        <button class="btn-icon btnDeleteWorkout">🗑️</button>
      </div>
      <div class="history-detail">
        ${w.entries.map((e) => `
          <div class="history-exercise-line">
            <b>${escapeHtml(e.exerciseName)}</b><br>
            <span class="history-sets-line">${e.sets.map((s) => `${s.weightKg}ק"ג×${s.reps}`).join('  ·  ')}</span>
          </div>
        `).join('')}
      </div>
    `;
    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.btnDeleteWorkout')) return;
      item.classList.toggle('open');
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

function computeVolume(workout) {
  return workout.entries.reduce((sum, e) => sum + e.sets.reduce((s2, s) => s2 + (s.weightKg * s.reps), 0), 0);
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
    { label: 'סה"כ אימונים', value: totalWorkouts },
    { label: 'נפח כולל (ק"ג)', value: Math.round(totalVolume).toLocaleString() },
    { label: 'זמן ממוצע', value: formatHMS(avgDuration) },
    { label: 'רצף שבועות', value: streak },
    { label: `השבוע (יעד ${settings.weeklyGoal})`, value: `${weekCount}/${settings.weeklyGoal}` },
    { label: 'סטים כולל', value: workouts.reduce((a, w) => a + w.entries.reduce((b, e) => b + e.sets.length, 0), 0) },
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
    exercises.push({ id: db.uid(), name: 'תרגיל חדש', category: 'כללי', defaultSets: 3, defaultReps: '12-15', restSeconds: 90, notes: '' });
    db.saveExercises(exercises);
    renderExercisesTab();
  });
}

function renderExercisesTab() {
  const list = el('exerciseManageList');
  list.innerHTML = '';
  exercises.forEach((ex) => {
    const item = document.createElement('div');
    item.className = 'exercise-manage-item';
    item.innerHTML = `
      <div class="exercise-manage-head">
        <b>${escapeHtml(ex.name)}</b>
        <button class="btn-icon btnDeleteEx">🗑️</button>
      </div>
      <div class="exercise-manage-fields">
        <div class="full"><label class="field-label">שם התרגיל</label><input class="input fName" value="${escapeAttr(ex.name)}"></div>
        <div><label class="field-label">קבוצת שריר</label><input class="input fCategory" value="${escapeAttr(ex.category)}"></div>
        <div><label class="field-label">סטים ברירת מחדל</label><input type="number" min="1" class="input fSets" value="${ex.defaultSets}"></div>
        <div><label class="field-label">חזרות</label><input class="input fReps" value="${escapeAttr(ex.defaultReps)}"></div>
        <div><label class="field-label">מנוחה (שניות)</label><input type="number" min="10" class="input fRest" value="${ex.restSeconds}"></div>
        <div class="full"><label class="field-label">הערות</label><input class="input fNotes" value="${escapeAttr(ex.notes || '')}"></div>
      </div>
    `;
    const save = () => {
      ex.name = qs('.fName', item).value || ex.name;
      ex.category = qs('.fCategory', item).value;
      ex.defaultSets = Math.max(1, Number(qs('.fSets', item).value) || 1);
      ex.defaultReps = qs('.fReps', item).value;
      ex.restSeconds = Math.max(10, Number(qs('.fRest', item).value) || 90);
      ex.notes = qs('.fNotes', item).value;
      db.saveExercises(exercises);
      qs('b', item).textContent = ex.name;
    };
    qsa('input', item).forEach((input) => input.addEventListener('change', save));
    qs('.btnDeleteEx', item).addEventListener('click', () => {
      if (!confirm(`למחוק את "${ex.name}"? אימוני עבר יישמרו.`)) return;
      exercises = exercises.filter((e) => e.id !== ex.id);
      db.saveExercises(exercises);
      renderExercisesTab();
    });
    list.appendChild(item);
  });
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
}

function renderSettingsTab() {
  el('settingRestSeconds').value = settings.restSeconds;
  el('settingWeeklyGoal').value = settings.weeklyGoal;
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

// db.js — localStorage persistence layer
const KEYS = {
  exercises: 'ft_exercises_v1',
  workouts: 'ft_workouts_v1',
  settings: 'ft_settings_v1',
  activeSession: 'ft_active_session_v1',
};

export function uid() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('read error', key, e);
    return fallback;
  }
}
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const DEFAULT_SETTINGS = {
  restSeconds: 120,
  weeklyGoal: 3,
  programWeek: 1, // week 1 = 1 set/exercise, week 2 = 2 sets, week 3+ = full (defaultSets)
  voiceAnnouncements: true,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
}
export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

export function getExercises() {
  return read(KEYS.exercises, []);
}
export function saveExercises(list) {
  write(KEYS.exercises, list);
}

export function getWorkouts() {
  return read(KEYS.workouts, []);
}
export function saveWorkouts(list) {
  write(KEYS.workouts, list);
}

export function getActiveSession() {
  return read(KEYS.activeSession, null);
}
export function saveActiveSession(session) {
  write(KEYS.activeSession, session);
}
export function clearActiveSession() {
  localStorage.removeItem(KEYS.activeSession);
}

export function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    exercises: getExercises(),
    workouts: getWorkouts(),
    settings: getSettings(),
  };
}

export function importAll(data) {
  if (data.exercises) saveExercises(data.exercises);
  if (data.workouts) saveWorkouts(data.workouts);
  if (data.settings) saveSettings(data.settings);
}

export function resetAll() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

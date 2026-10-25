(() => {
  "use strict";

  function requireStorage(storage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new TypeError("A Web Storage-compatible object is required.");
    }
    return storage;
  }

  const FAMILIES = ["tracking", "completed", "preferences"];

  function requireKeys(keys) {
    for (const family of ["current", "legacy"]) {
      for (const name of FAMILIES) {
        if (!String(keys?.[family]?.[name] || "")) {
          throw new TypeError(`Missing ${family}.${name} storage key.`);
        }
      }
    }
    return keys;
  }

  function parseValue(raw, fallback) {
    return raw === null || raw === "" ? fallback : JSON.parse(raw);
  }

  function readLocalSnapshot(storage, keys) {
    const target = requireStorage(storage);
    const names = requireKeys(keys);
    const current = Object.fromEntries(FAMILIES.map((name) => [name, target.getItem(names.current[name])]));
    const legacy = Object.fromEntries(FAMILIES.map((name) => [name, target.getItem(names.legacy[name])]));
    const raw = Object.fromEntries(FAMILIES.map((name) => [name, current[name] ?? legacy[name]]));
    const migratedFamilies = FAMILIES.filter(
      (name) => current[name] === null && legacy[name] !== null,
    );
    return {
      tracking: parseValue(raw.tracking, []),
      completed: parseValue(raw.completed, []),
      preferences: parseValue(raw.preferences, {}),
      completedChanges: names.current.completedChanges
        ? parseValue(target.getItem(names.current.completedChanges), {})
        : {},
      present: Object.values(raw).some((value) => value !== null && value !== ""),
      shouldMigrate: migratedFamilies.length > 0,
      migratedFamilies,
    };
  }

  function writeLocalSnapshot(storage, keys, snapshot) {
    const target = requireStorage(storage);
    const names = requireKeys(keys);
    target.setItem(names.current.tracking, JSON.stringify(snapshot?.tracking || []));
    target.setItem(names.current.completed, JSON.stringify(snapshot?.completed || []));
    target.setItem(names.current.preferences, JSON.stringify(snapshot?.preferences || {}));
    if (names.current.completedChanges) {
      target.setItem(names.current.completedChanges, JSON.stringify(snapshot?.completedChanges || {}));
    }
  }

  function completionChanges(value) {
    const changes = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return changes;
    for (const [id, change] of Object.entries(value)) {
      if (id && Array.isArray(change) && (change[0] === 0 || change[0] === 1) && Number.isSafeInteger(change[1])) {
        changes[id] = [change[0], change[1]];
      }
    }
    return changes;
  }

  // Completion flags carry a change log ({ id: [1 = set | 0 = cleared, unix ms] }), so the newest change wins
  // across this browser, other devices and the desktop app. A completed id without a logged change counts as set
  // at time 0; an id missing from one side is not a clear. The API merges the same way.
  function mergeCompletion(...snapshots) {
    const latest = new Map();
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const changes = completionChanges(snapshot.completedChanges);
      for (const entry of Array.isArray(snapshot.completed) ? snapshot.completed : []) {
        const id = String(entry || "").trim();
        if (id && !changes[id] && !latest.has(id)) latest.set(id, [1, 0]);
      }
      for (const [id, change] of Object.entries(changes)) {
        const prior = latest.get(id);
        if (!prior || change[1] > prior[1] || (change[1] === prior[1] && change[0] === 1)) latest.set(id, change);
      }
    }
    return {
      completed: [...latest].filter(([, change]) => change[0] === 1).map(([id]) => id),
      completedChanges: Object.fromEntries([...latest].filter(([, change]) => change[1] > 0)
        .sort((a, b) => b[1][1] - a[1][1]).slice(0, 15000)),
    };
  }

  function mergeSnapshots(remote, local, { mergeLocal = false, normalizeTrackingEntry = (entry) => entry } = {}) {
    const remoteTracking = Array.isArray(remote?.tracking)
      ? remote.tracking.map(normalizeTrackingEntry).filter(Boolean)
      : [];
    const combinedTracking = new Map(remoteTracking.map((entry) => [entry.id, entry]));
    if (mergeLocal) {
      const localTracking = Array.isArray(local?.tracking) ? local.tracking : [];
      for (const candidate of localTracking) {
        const entry = normalizeTrackingEntry(candidate);
        if (entry) combinedTracking.set(entry.id, entry);
      }
    }

    const completion = mergeCompletion(remote, mergeLocal ? local : null);

    const remotePreferences = remote?.preferences && typeof remote.preferences === "object"
      ? remote.preferences
      : {};
    const localPreferences = local?.preferences && typeof local.preferences === "object"
      ? local.preferences
      : {};
    return {
      tracking: [...combinedTracking.values()],
      completed: completion.completed,
      completedChanges: completion.completedChanges,
      preferences: mergeLocal
        ? { ...remotePreferences, ...localPreferences }
        : { ...remotePreferences },
    };
  }

  globalThis.AniiLogsProgressStorage = Object.freeze({
    readLocalSnapshot,
    writeLocalSnapshot,
    mergeSnapshots,
    mergeCompletion,
    completionChanges,
  });
})();

(() => {
  "use strict";

  function requireStorage(storage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new TypeError("A Web Storage-compatible object is required.");
    }
    return storage;
  }

  function requireKeys(keys) {
    for (const family of ["current", "legacy"]) {
      for (const name of ["tracking", "completed", "preferences"]) {
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
    const current = Object.fromEntries(
      Object.entries(names.current).map(([name, key]) => [name, target.getItem(key)]),
    );
    const legacy = Object.fromEntries(
      Object.entries(names.legacy).map(([name, key]) => [name, target.getItem(key)]),
    );
    const raw = Object.fromEntries(
      Object.keys(names.current).map((name) => [name, current[name] ?? legacy[name]]),
    );
    const migratedFamilies = Object.keys(names.current).filter(
      (name) => current[name] === null && legacy[name] !== null,
    );
    return {
      tracking: parseValue(raw.tracking, []),
      completed: parseValue(raw.completed, []),
      preferences: parseValue(raw.preferences, {}),
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

    const completed = new Set(
      Array.isArray(remote?.completed)
        ? remote.completed.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
    );
    if (mergeLocal) {
      for (const entry of Array.isArray(local?.completed) ? local.completed : []) {
        const id = String(entry || "").trim();
        if (id) completed.add(id);
      }
    }

    const remotePreferences = remote?.preferences && typeof remote.preferences === "object"
      ? remote.preferences
      : {};
    const localPreferences = local?.preferences && typeof local.preferences === "object"
      ? local.preferences
      : {};
    return {
      tracking: [...combinedTracking.values()],
      completed: [...completed],
      preferences: mergeLocal
        ? { ...remotePreferences, ...localPreferences }
        : { ...remotePreferences },
    };
  }

  globalThis.AniiLogsProgressStorage = Object.freeze({
    readLocalSnapshot,
    writeLocalSnapshot,
    mergeSnapshots,
  });
})();

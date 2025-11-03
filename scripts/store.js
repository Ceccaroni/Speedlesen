// scripts/store.js
// IndexedDB-Speicher für Speedlesen – Gruppen, Wochen, Einstellungen
// Schema v1: DB "speedlesen_db_v1", Stores: groups, weeks, settings

const DB_NAME = "speedlesen_db_v1";
const DB_VERSION = 1;

export class Store {
  constructor() {
    this.db = null;
    this.ready = this.#open();
  }

  // ---------------- Intern: DB öffnen / Schema anlegen ----------------
  #open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // groups: key = id (Gruppenname), value = { id, personen: [{pid?, name}], createdAt }
        if (!db.objectStoreNames.contains("groups")) {
          const st = db.createObjectStore("groups", { keyPath: "id" });
          st.createIndex("by_id", "id", { unique: true });
        }

        // weeks: key = `${gruppe}#${woche}`, value = Messdatensatz einer Woche
        if (!db.objectStoreNames.contains("weeks")) {
          const st = db.createObjectStore("weeks", { keyPath: "key" });
          st.createIndex("by_gruppe", "gruppe", { unique: false });
          st.createIndex("by_gruppe_woche", ["gruppe", "woche"], { unique: true });
        }

        // settings: key = name, value = { name, value }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "name" });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------- Hilfen ----------------
  #tx(storeNames, mode = "readonly") {
    const tx = this.db.transaction(storeNames, mode);
    return {
      tx,
      store: (name) => tx.objectStore(name),
      done: () =>
        new Promise((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error || new Error("TX aborted"));
        }),
    };
  }

  // ---------------- Settings ----------------
  async getSetting(name, fallback = null) {
    await this.ready;
    const { tx, store } = this.#tx(["settings"]);
    const req = store("settings").get(name);
    const val = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result ? req.result.value : fallback);
      req.onerror = () => rej(req.error);
    });
    await new Promise((r)=>{ tx.oncomplete = r; });
    return val;
  }

  async setSetting(name, value) {
    await this.ready;
    const { tx, store, done } = this.#tx(["settings"], "readwrite");
    store("settings").put({ name, value });
    await done();
  }

  // Bequem: Modus A+B(+C+D) ablegen/lesen
  async getMode() { return this.getSetting("modus", "standard"); }
  async setMode(mode) { return this.setSetting("modus", mode); }

  // ---------------- Groups ----------------
  async getGroups() {
    await this.ready;
    const { tx, store } = this.#tx(["groups"]);
    const st = store("groups");
    const req = st.getAll();
    const rows = await new Promise((res, rej)=>{
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    await new Promise((r)=>{ tx.oncomplete = r; });
    rows.sort((a,b)=> (a.id > b.id ? 1 : -1));
    return rows;
  }

  /**
   * Gruppe anlegen/aktualisieren.
   * @param {{id:string, personen?:Array<{pid?:string,name:string}>}} group
   */
  async upsertGroup(group) {
    await this.ready;
    const now = Date.now();
    const row = {
      id: String(group.id),
      personen: Array.isArray(group.personen) ? group.personen.map(p=>({
        pid: p.pid || p.name,
        name: p.name
      })) : [],
      createdAt: group.createdAt || now,
      updatedAt: now,
    };
    const { tx, store, done } = this.#tx(["groups"], "readwrite");
    store("groups").put(row);
    await done();
    return row;
  }

  // --- Legacy-Kompatibilität: addGroup(g) -> upsertGroup(g)
  async addGroup(g){ return this.upsertGroup(g); }

  // ---------------- Members (als Teil der Gruppe) ----------------
  /**
   * Legacy-API: fügt ein Mitglied in group.personen ein.
   * @param {{id?:string, pid?:string, name:string, gruppe_id:string}} m
   */
  async addMember(m){
    await this.ready;
    const gruppeId = m.gruppe_id || m.gruppe || m.group || "";
    if (!gruppeId) throw new Error("addMember: gruppe_id fehlt.");
    const pid = m.pid || m.id || m.name;

    const { tx, store, done } = this.#tx(["groups"], "readwrite");
    const st = store("groups");
    const get = st.get(gruppeId);
    const group = await new Promise((res, rej)=>{
      get.onsuccess = () => res(get.result || { id: gruppeId, personen: [], createdAt: Date.now() });
      get.onerror = () => rej(get.error);
    });

    const exists = (group.personen || []).some(p => (p.pid||p.name) === pid);
    if (!exists){
      group.personen = [...(group.personen||[]), { pid, name: m.name }];
      group.updatedAt = Date.now();
      st.put(group);
    }
    await done();
    return group;
  }

  /**
   * Legacy-API: Mitglieder einer Gruppe.
   */
  async getMembersByGroup(gruppeId){
    await this.ready;
    const { tx, store, done } = this.#tx(["groups"], "readonly");
    const st = store("groups");
    const get = st.get(gruppeId);
    const group = await new Promise((res, rej)=>{
      get.onsuccess = () => res(get.result || null);
      get.onerror = () => rej(get.error);
    });
    await done();
    return group ? (group.personen || []) : [];
  }

  // ---------------- Weeks ----------------
  /**
   * Wochen einer Gruppe lesen (sortiert)
   */
  async getGroupWeeks(gruppeId) {
    await this.ready;
    const { tx, store } = this.#tx(["weeks"]);
    const idx = store("weeks").index("by_gruppe");
    const req = idx.getAll(IDBKeyRange.only(gruppeId));
    const rows = await new Promise((res, rej)=>{
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    await new Promise((r)=>{ tx.oncomplete = r; });
    rows.sort((a,b)=> a.woche - b.woche);
    return rows;
  }

  /**
   * Woche schreiben (atomar). Erwartet extern berechnete Werte.
   */
  async writeWeek(week) {
    await this.ready;

    if (!week || !week.gruppe || typeof week.woche !== "number") {
      throw new Error("writeWeek: unvollständige Angaben (gruppe, woche Pflicht).");
    }
    const key = `${week.gruppe}#${week.woche}`;

    const persons = (week.personen || []).map(p => ({
      pid: p.pid || p.name,
      name: p.name,
      woerter3: Number(p.woerter3 ?? 0),
      wpm: Number(p.wpm ?? 0),
      wps: Number(p.wps ?? 0),
      fehler: Number(p.fehler ?? 0),
      wcpm: Number(p.wcpm ?? 0),
      punkte_person: Number(p.punkte_person ?? 0)
    }));

    const flags = {
      A_WPM_verbessert: !!(week.flags && week.flags.A_WPM_verbessert),
      B_Fehler_reduziert: !!(week.flags && week.flags.B_Fehler_reduziert),
      Coaching: !!(week.flags && (week.flags.Coaching || week.flags.coaching)),
      Mission: !!(week.flags && (week.flags.Mission || week.flags.mission))
    };

    const row = {
      key,
      gruppe: String(week.gruppe),
      woche: Number(week.woche),
      anzahl_personen: Number(week.anzahl_personen || persons.length || 0),
      personen: persons,
      flags,
      punkte_gruppe_roh: Number(week.punkte_gruppe_roh ?? 0),
      punkte_gruppe_normalisiert: Number(week.punkte_gruppe_normalisiert ?? 0),
      punkte_gruppe_kumuliert: Number(week.punkte_gruppe_kumuliert ?? 0),
      savedAt: Date.now()
    };

    const { tx, store, done } = this.#tx(["weeks", "groups"], "readwrite");
    store("weeks").put(row);

    // Gruppe synchronisieren
    const gStore = store("groups");
    const gGet = gStore.get(row.gruppe);
    const group = await new Promise((res, rej)=>{
      gGet.onsuccess = () => res(gGet.result || null);
      gGet.onerror = () => rej(gGet.error);
    });

    if (group) {
      const known = new Map((group.personen || []).map(p => [p.pid || p.name, { pid: p.pid || p.name, name: p.name }]));
      for (const p of persons) {
        if (!known.has(p.pid)) known.set(p.pid, { pid: p.pid, name: p.name });
      }
      group.personen = Array.from(known.values());
      group.updatedAt = Date.now();
      gStore.put(group);
    } else {
      gStore.put({
        id: row.gruppe,
        personen: persons.map(p => ({ pid: p.pid, name: p.name })),
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    await done();
    return row;
  }

  // --- Legacy-Kompatibilität: saveMeasurement(m) -> writeWeek(...)
  /**
   * Erwartet altes Messungsformat:
   * { id?, gruppe_id, gruppe?, woche, personen:[{name,pid?,woerter3,wpm,wps,fehler,wcpm,punkte_person}], flags?, punkte_gruppe_roh?, punkte_gruppe_normalisiert?, punkte_gruppe_kumuliert? }
   */
  async saveMeasurement(m){
    const gruppe = m.gruppe_id || m.gruppe;
    const woche = Number(m.woche ?? this.#inferWeekFromId(m.id));
    if (!gruppe || !Number.isFinite(woche)) throw new Error("saveMeasurement: gruppe_id/woche fehlen.");
    return this.writeWeek({
      gruppe,
      woche,
      anzahl_personen: m.anzahl_personen ?? (m.personen?.length || 0),
      personen: m.personen || [],
      flags: m.flags || {},
      punkte_gruppe_roh: m.punkte_gruppe_roh,
      punkte_gruppe_normalisiert: m.punkte_gruppe_normalisiert,
      punkte_gruppe_kumuliert: m.punkte_gruppe_kumuliert
    });
  }

  #inferWeekFromId(id){
    if (!id) return NaN;
    const m = String(id).match(/#(\d+)$/);
    return m ? Number(m[1]) : NaN;
  }

  // ---------------- Utilities ----------------
  async resetAll() {
    await this.ready;
    const { tx, store, done } = this.#tx(["groups", "weeks", "settings"], "readwrite");
    store("groups").clear();
    store("weeks").clear();
    store("settings").clear();
    await done();
  }

  async exportJSON() {
    await this.ready;
    const [groups, weeks, settings] = await Promise.all([
      this.getGroups(),
      (async () => {
        const { tx, store } = this.#tx(["weeks"]);
        const req = store("weeks").getAll();
        const rows = await new Promise((res, rej)=>{ req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); });
        await new Promise((r)=>{ tx.oncomplete = r; });
        return rows;
      })(),
      (async () => {
        const { tx, store } = this.#tx(["settings"]);
        const req = store("settings").getAll();
        const rows = await new Promise((res, rej)=>{ req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); });
        await new Promise((r)=>{ tx.oncomplete = r; });
        return rows;
      })()
    ]);
    return { version: DB_VERSION, groups, weeks, settings, exportedAt: new Date().toISOString() };
  }

  async importJSON(payload, { overwrite = false } = {}) {
    await this.ready;
    if (!payload || typeof payload !== "object") throw new Error("importJSON: ungültige Daten.");
    const { groups = [], weeks = [], settings = [] } = payload;

    const { tx, store, done } = this.#tx(["groups", "weeks", "settings"], "readwrite");
    if (overwrite) {
      store("groups").clear();
      store("weeks").clear();
      store("settings").clear();
    }
    const sg = store("groups");
    const sw = store("weeks");
    const ss = store("settings");

    for (const g of groups) sg.put(g);
    for (const w of weeks) sw.put(w);
    for (const s of settings) ss.put(s);

    await done();
  }
}

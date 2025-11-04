// scripts/store.js
// IndexedDB – Legacy-Schema: 'gruppen' / 'mitglieder' / 'messungen'
// Bewahrt bestehende Daten. Alias-Feld ergänzt.

const DB_NAME = 'speedlesen_db_v1';
const DB_VER  = 1;

function reqp(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); }); }
function txDone(tx){ return new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); tx.onabort=()=>rej(tx.error); }); }

export class Store{
  constructor(){ this.ready = this.#init(); }

  async #init(){
    if (!('indexedDB' in window)){
      this.fallback = true;
      this.memory = JSON.parse(localStorage.getItem(DB_NAME) || '{"gruppen":[],"mitglieder":[],"messungen":[]}');
      return;
    }
    this.db = await openDb();
  }

  // ---------------- Gruppen ----------------
  async addGroup(g){
    if (this.fallback){
      const s = this.memory;
      if (!s.gruppen.find(x=>x.id===g.id)) s.gruppen.push({ id: String(g.id) });
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }
    const tx = this.db.transaction('gruppen', 'readwrite');
    await reqp(tx.objectStore('gruppen').put({ id: String(g.id) }));
    await txDone(tx);
  }

  async getGroups(){
    if (this.fallback) return this.memory.gruppen.slice().sort((a,b)=>a.id>b.id?1:-1);
    const tx = this.db.transaction('gruppen', 'readonly');
    const res = await reqp(tx.objectStore('gruppen').getAll());
    await txDone(tx);
    return (res || []).sort((a,b)=>a.id>b.id?1:-1);
  }

  // ---------------- Mitglieder ----------------
  /**
   * m: { id?, pid?, name, alias?, gruppe_id }
   */
  async addMember(m){
    const gruppeId = m.gruppe_id || m.gruppe || m.group;
    if (!gruppeId) throw new Error("addMember: gruppe_id fehlt.");
    const pid = m.pid || m.id || m.name;
    const name = m.name;
    const alias = m.alias || m.name;

    if (this.fallback){
      const s = this.memory;
      if (!s.mitglieder.find(x=> (x.pid||x.id||x.name)===pid && x.gruppe_id===gruppeId)){
        s.mitglieder.push({ id: pid, pid, name, alias, gruppe_id: gruppeId });
      }
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }

    const tx = this.db.transaction(['gruppen','mitglieder'],'readwrite');
    // Gruppe sicherstellen
    const gstore = tx.objectStore('gruppen');
    const g = await reqp(gstore.get(gruppeId));
    if (!g) await reqp(gstore.put({ id: gruppeId }));

    // Mitglied anlegen (kein Unique-Index → doppelt vermeiden)
    const mstore = tx.objectStore('mitglieder');
    const all = await reqp(mstore.index('by_gruppe').getAll(gruppeId));
    const exists = (all||[]).some(x => (x.pid||x.id||x.name)===pid);
    if (!exists){
      await reqp(mstore.put({ id: `${gruppeId}::${pid}`, pid, name, alias, gruppe_id: gruppeId }));
    }
    await txDone(tx);
  }

  async getMembersByGroup(gruppeId){
    if (this.fallback){
      return (this.memory.mitglieder||[])
        .filter(x=>x.gruppe_id===gruppeId)
        .map(p=>({ ...p, alias: p.alias || p.name }));
    }
    const tx = this.db.transaction('mitglieder','readonly');
    const idx = tx.objectStore('mitglieder').index('by_gruppe');
    const res = await reqp(idx.getAll(gruppeId));
    await txDone(tx);
    return (res||[]).map(p=>({ ...p, alias: p.alias || p.name }));
  }

  // ---------------- Messungen (Wochen) ----------------
  /**
   * messung: {
   *   id: `${gruppe}_W${woche}`,
   *   gruppe_id, woche, anzahl_personen,
   *   personen:[{pid?,name,alias?,woerter3,wpm,wps,fehler,wcpm,punkte_person}],
   *   flags, punkte_gruppe_roh, punkte_gruppe_normalisiert, punkte_gruppe_kumuliert, timestamp
   * }
   */
  async saveMeasurement(m){
    if (this.fallback){
      const s = this.memory;
      const i = s.messungen.findIndex(x=>x.id===m.id);
      if (i>=0) s.messungen[i]=m; else s.messungen.push(m);
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }
    const tx = this.db.transaction(['messungen','gruppen','mitglieder'],'readwrite');

    // Gruppe sicherstellen
    const gstore = tx.objectStore('gruppen');
    const g = await reqp(gstore.get(m.gruppe_id));
    if (!g) await reqp(gstore.put({ id: m.gruppe_id }));

    // Mitgliederliste pflegen (alias dranlassen)
    const mstore = tx.objectStore('mitglieder');
    const known = await reqp(mstore.index('by_gruppe').getAll(m.gruppe_id));
    const knownMap = new Map((known||[]).map(x=>[(x.pid||x.id||x.name), x]));
    for (const p of (m.personen||[])){
      const pid = p.pid || p.name;
      if (!knownMap.has(pid)){
        await reqp(mstore.put({
          id: `${m.gruppe_id}::${pid}`,
          pid, name: p.name, alias: p.alias || p.name,
          gruppe_id: m.gruppe_id
        }));
      }
    }

    // Messung schreiben
    await reqp(tx.objectStore('messungen').put(m));
    await txDone(tx);
  }

  async getGroupWeeks(gruppeId){
    if (this.fallback){
      return (this.memory.messungen||[]).filter(x=>x.gruppe_id===gruppeId).sort((a,b)=>a.woche-b.woche);
    }
    const tx = this.db.transaction('messungen','readonly');
    const idx = tx.objectStore('messungen').index('by_gruppe');
    const res = await reqp(idx.getAll(gruppeId));
    await txDone(tx);
    return (res||[]).sort((a,b)=>a.woche-b.woche);
  }

  // ---------------- Import (neu) ----------------
  /**
   * Unterstützt zwei Formate:
   * – Neues Format: { groups:[{id,personen:[{pid,name,alias}]}], weeks:[{gruppe,woche,...}], settings:[] }
   * – Legacy-Format: { gruppen:[], mitglieder:[], messungen:[] }
   */
  async importJSON(payload, { overwrite = false } = {}){
    await this.ready;
    if (!payload || typeof payload !== 'object'){
      throw new Error('importJSON: ungültige Daten.');
    }

    const hasNew = Array.isArray(payload.groups) || Array.isArray(payload.weeks);
    const hasLegacy = Array.isArray(payload.gruppen) || Array.isArray(payload.mitglieder) || Array.isArray(payload.messungen);
    if (!hasNew && !hasLegacy) throw new Error('importJSON: unerwartetes Format.');

    // Fallback: in-Memory zusammenführen
    if (this.fallback){
      const s = this.memory;
      if (overwrite){ s.gruppen=[]; s.mitglieder=[]; s.messungen=[]; }
      if (hasLegacy){
        (payload.gruppen||[]).forEach(g=>{
          if (!s.gruppen.find(x=>x.id===g.id)) s.gruppen.push({id:String(g.id)});
        });
        (payload.mitglieder||[]).forEach(m=>{
          const id = `${m.gruppe_id}::${m.pid||m.id||m.name}`;
          if (!s.mitglieder.find(x=>x.id===id)){
            s.mitglieder.push({ id, pid:m.pid||m.id||m.name, name:m.name, alias:m.alias||m.name, gruppe_id:String(m.gruppe_id) });
          }
        });
        (payload.messungen||[]).forEach(w=>{
          const i = s.messungen.findIndex(x=>x.id===w.id);
          if (i>=0) s.messungen[i]=w; else s.messungen.push(w);
        });
      } else {
        (payload.groups||[]).forEach(g=>{
          if (!s.gruppen.find(x=>x.id===g.id)) s.gruppen.push({id:String(g.id)});
          (g.personen||[]).forEach(p=>{
            const pid = p.pid || p.id || p.name;
            const id = `${g.id}::${pid}`;
            if (!s.mitglieder.find(x=>x.id===id)){
              s.mitglieder.push({ id, pid, name:p.name, alias:p.alias||p.name, gruppe_id:String(g.id) });
            }
          });
        });
        (payload.weeks||[]).forEach(w=>{
          const row = {
            id: `${w.gruppe}_W${w.woche}`,
            gruppe_id: String(w.gruppe),
            woche: Number(w.woche),
            anzahl_personen: Number(w.anzahl_personen || (w.personen?.length||0)),
            personen: (w.personen||[]).map(p=>({ pid:p.pid||p.name, name:p.name, alias:p.alias||p.name, woerter3:p.woerter3, wpm:p.wpm, wps:p.wps, fehler:p.fehler, wcpm:p.wcpm, punkte_person:p.punkte_person })),
            flags: w.flags || {},
            punkte_gruppe_roh: w.punkte_gruppe_roh,
            punkte_gruppe_normalisiert: w.punkte_gruppe_normalisiert,
            punkte_gruppe_kumuliert: w.punkte_gruppe_kumuliert,
            timestamp: w.savedAt || Date.now()
          };
          const i = s.messungen.findIndex(x=>x.id===row.id);
          if (i>=0) s.messungen[i]=row; else s.messungen.push(row);
        });
      }
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }

    // IndexedDB: schreiben
    const tx = this.db.transaction(['gruppen','mitglieder','messungen'], 'readwrite');
    const stG = tx.objectStore('gruppen');
    const stM = tx.objectStore('mitglieder');
    const stW = tx.objectStore('messungen');

    if (overwrite){
      await reqp(stG.clear());
      await reqp(stM.clear());
      await reqp(stW.clear());
    }

    if (hasLegacy){
      for (const g of (payload.gruppen||[])){
        await reqp(stG.put({ id: String(g.id) }));
      }
      for (const m of (payload.mitglieder||[])){
        const pid = m.pid || m.id || m.name;
        await reqp(stM.put({ id: `${m.gruppe_id}::${pid}`, pid, name:m.name, alias:m.alias||m.name, gruppe_id:String(m.gruppe_id) }));
      }
      for (const w of (payload.messungen||[])){
        await reqp(stW.put(w));
      }
    } else {
      for (const g of (payload.groups||[])){
        await reqp(stG.put({ id: String(g.id) }));
        for (const p of (g.personen||[])){
          const pid = p.pid || p.id || p.name;
          await reqp(stM.put({ id: `${g.id}::${pid}`, pid, name:p.name, alias:p.alias||p.name, gruppe_id:String(g.id) }));
        }
      }
      for (const w of (payload.weeks||[])){
        const row = {
          id: `${w.gruppe}_W${w.woche}`,
          gruppe_id: String(w.gruppe),
          woche: Number(w.woche),
          anzahl_personen: Number(w.anzahl_personen || (w.personen?.length||0)),
          personen: (w.personen||[]).map(p=>({ pid:p.pid||p.name, name:p.name, alias:p.alias||p.name, woerter3:p.woerter3, wpm:p.wpm, wps:p.wps, fehler:p.fehler, wcpm:p.wcpm, punkte_person:p.punkte_person })),
          flags: w.flags || {},
          punkte_gruppe_roh: w.punkte_gruppe_roh,
          punkte_gruppe_normalisiert: w.punkte_gruppe_normalisiert,
          punkte_gruppe_kumuliert: w.punkte_gruppe_kumuliert,
          timestamp: w.savedAt || Date.now()
        };
        await reqp(stW.put(row));
      }
    }

    await txDone(tx);
  }

  // ---------------- Export (neu) ----------------
  /**
   * Export im „neuen“ Format {groups,weeks,settings}.
   * Import akzeptiert beide Formate.
   */
  async exportJSON(){
    await this.ready;

    if (this.fallback){
      // aus memory → neues Format
      const groups = (this.memory.gruppen||[]).map(g=>{
        const personen = (this.memory.mitglieder||[])
          .filter(m=>m.gruppe_id===g.id)
          .map(m=>({ pid:m.pid||m.id||m.name, name:m.name, alias:m.alias||m.name }));
        return { id: String(g.id), personen };
      });
      const weeks = (this.memory.messungen||[]).map(w=>({
        gruppe: String(w.gruppe_id),
        woche: Number(w.woche),
        anzahl_personen: Number(w.anzahl_personen|| (w.personen?.length||0)),
        personen: (w.personen||[]).map(p=>({
          pid:p.pid||p.name, name:p.name, alias:p.alias||p.name,
          woerter3:p.woerter3, wpm:p.wpm, wps:p.wps, fehler:p.fehler, wcpm:p.wcpm, punkte_person:p.punkte_person
        })),
        flags: w.flags||{},
        punkte_gruppe_roh: w.punkte_gruppe_roh,
        punkte_gruppe_normalisiert: w.punkte_gruppe_normalisiert,
        punkte_gruppe_kumuliert: w.punkte_gruppe_kumuliert,
        savedAt: w.timestamp || Date.now()
      }));
      return { version: DB_VER, groups, weeks, settings: [], exportedAt: new Date().toISOString() };
    }

    const tx = this.db.transaction(['gruppen','mitglieder','messungen'], 'readonly');
    const stG = tx.objectStore('gruppen');
    const stM = tx.objectStore('mitglieder');
    const stW = tx.objectStore('messungen');

    const gruppen = await reqp(stG.getAll());
    const mitglieder = await reqp(stM.getAll());
    const messungen = await reqp(stW.getAll());
    await txDone(tx);

    const groups = (gruppen||[]).map(g=>{
      const personen = (mitglieder||[])
        .filter(m=>m.gruppe_id===g.id)
        .map(m=>({ pid:m.pid||m.id||m.name, name:m.name, alias:m.alias||m.name }));
      return { id: String(g.id), personen };
    });

    const weeks = (messungen||[]).map(w=>({
      gruppe: String(w.gruppe_id),
      woche: Number(w.woche),
      anzahl_personen: Number(w.anzahl_personen|| (w.personen?.length||0)),
      personen: (w.personen||[]).map(p=>({
        pid:p.pid||p.name, name:p.name, alias:p.alias||p.name,
        woerter3:p.woerter3, wpm:p.wpm, wps:p.wps, fehler:p.fehler, wcpm:p.wcpm, punkte_person:p.punkte_person
      })),
      flags: w.flags||{},
      punkte_gruppe_roh: w.punkte_gruppe_roh,
      punkte_gruppe_normalisiert: w.punkte_gruppe_normalisiert,
      punkte_gruppe_kumuliert: w.punkte_gruppe_kumuliert,
      savedAt: w.timestamp || Date.now()
    }));

    return { version: DB_VER, groups, weeks, settings: [], exportedAt: new Date().toISOString() };
  }
}

// ---- DB öffnen / Schema (Legacy) ----
function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = ()=>{
      const db = req.result;

      if (!db.objectStoreNames.contains('gruppen')){
        db.createObjectStore('gruppen', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('mitglieder')){
        const os = db.createObjectStore('mitglieder', { keyPath: 'id' });
        os.createIndex('by_gruppe','gruppe_id',{unique:false});
      }
      if (!db.objectStoreNames.contains('messungen')){
        const os = db.createObjectStore('messungen', { keyPath: 'id' });
        os.createIndex('by_gruppe','gruppe_id',{unique:false});
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

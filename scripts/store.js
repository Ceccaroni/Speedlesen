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

// IndexedDB mit robusten Promise-Wrappern; Fallback localStorage
const DB_NAME = 'speedlesen_db_v1';
const DB_VER = 1;

function reqp(req){
  return new Promise((resolve, reject)=>{
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

function txDone(tx){
  return new Promise((resolve, reject)=>{
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
    tx.onabort = ()=> reject(tx.error);
  });
}

export class Store{
  constructor(){
    this.ready = this.#init();
  }

  async #init(){
    if (!('indexedDB' in window)){
      this.fallback = true;
      this.memory = JSON.parse(localStorage.getItem(DB_NAME) || '{"gruppen":[],"mitglieder":[],"messungen":[]}');
      return;
    }
    this.db = await openDb();
  }

  // Gruppen
  async addGroup(g){
    if (this.fallback){
      const s = this.memory;
      if (!s.gruppen.find(x=>x.id===g.id)) s.gruppen.push(g);
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }
    const tx = this.db.transaction('gruppen', 'readwrite');
    await reqp(tx.objectStore('gruppen').put(g));
    await txDone(tx);
  }

  async getGroups(){
    if (this.fallback){
      return this.memory.gruppen;
    }
    const tx = this.db.transaction('gruppen', 'readonly');
    const res = await reqp(tx.objectStore('gruppen').getAll());
    await txDone(tx);
    return res;
  }

  // Mitglieder
  async addMember(m){
    if (this.fallback){
      const s = this.memory;
      if (!s.mitglieder.find(x=>x.id===m.id)) s.mitglieder.push(m);
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }
    const tx = this.db.transaction('mitglieder', 'readwrite');
    await reqp(tx.objectStore('mitglieder').put(m));
    await txDone(tx);
  }

  async getMembersByGroup(gruppeId){
    if (this.fallback){
      return this.memory.mitglieder.filter(x=>x.gruppe_id===gruppeId);
    }
    const tx = this.db.transaction('mitglieder', 'readonly');
    const idx = tx.objectStore('mitglieder').index('by_gruppe');
    const res = await reqp(idx.getAll(gruppeId));
    await txDone(tx);
    return res;
  }

  // Messungen
  async saveMeasurement(m){
    if (this.fallback){
      const s = this.memory;
      const i = s.messungen.findIndex(x=>x.id===m.id);
      if (i>=0) s.messungen[i]=m; else s.messungen.push(m);
      localStorage.setItem(DB_NAME, JSON.stringify(s));
      return;
    }
    const tx = this.db.transaction('messungen', 'readwrite');
    await reqp(tx.objectStore('messungen').put(m));
    await txDone(tx);
  }

  async getGroupWeeks(gruppeId){
    if (this.fallback){
      return this.memory.messungen.filter(x=>x.gruppe_id===gruppeId);
    }
    const tx = this.db.transaction('messungen', 'readonly');
    const idx = tx.objectStore('messungen').index('by_gruppe');
    const res = await reqp(idx.getAll(gruppeId));
    await txDone(tx);
    return res;
  }
}

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

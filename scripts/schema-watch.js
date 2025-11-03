// scripts/schema-watch.js
// Prüft das erwartete IndexedDB-Schema und zeigt bei Mismatch eine fixe Warnleiste.

function el(tag, attrs={}, children=[]){
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v])=> (k==="style") ? (n.style.cssText=v) : n.setAttribute(k,v));
  (Array.isArray(children)?children:[children]).forEach(c=> n.append(c));
  return n;
}

async function openDb(name, ver){
  return new Promise((res, rej)=>{
    const r = indexedDB.open(name, ver);
    r.onsuccess = ()=> res(r.result);
    r.onerror   = ()=> rej(r.error || new Error("DB open failed"));
  });
}

function showBar(msg){
  const bar = el("div", {
    style: "position:sticky;top:0;left:0;right:0;z-index:9999;" +
           "background:#ff3b30;color:#fff;padding:10px 16px;" +
           "display:flex;gap:12px;align-items:center;font-weight:700"
  }, [
    msg,
    el("button", {class:"btn-ghost", style:"margin-left:auto;background:#fff;color:#000;border-radius:12px;padding:6px 10px;border:none;cursor:pointer"}, "Hart neu laden")
  ]);
  bar.querySelector("button").onclick = ()=>{
    const url = new URL(location.href);
    url.searchParams.set("cache", Date.now().toString());
    location.replace(url.toString());
  };
  document.body.prepend(bar);
}

export async function watchSchema({ dbName, version, expect }){
  try{
    const db = await openDb(dbName, version);
    const names = new Set([...db.objectStoreNames]);
    db.close();
    const ok = expect.every(x => names.has(x));
    if (!ok){
      const have = [...names].sort().join(", ");
      const need = [...expect].sort().join(", ");
      showBar(`Schema-Mismatch in "${dbName}": vorhanden [${have}] · erwartet [${need}].`);
    }
  }catch(e){
    showBar(`Schema-Prüfung fehlgeschlagen: ${String(e && e.message || e)}`);
  }
}

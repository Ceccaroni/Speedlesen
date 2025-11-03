// scripts/backup.js – JSON-Backup mit SHA-256 Prüfsumme

function buf2hex(buf){ return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
async function sha256Hex(str){ const enc=new TextEncoder().encode(str); const d=await crypto.subtle.digest("SHA-256",enc); return buf2hex(d); }

export async function createBackupPayload(store){
  const data = await store.exportJSON(); // {version, groups|gruppen, weeks|messungen, settings, exportedAt}
  const core = JSON.stringify(data);
  const hash = await sha256Hex(core);
  return { format:"speedlesen.backup.v1", dbVersion:data.version, exportedAt:new Date().toISOString(), hash, data };
}

export async function downloadBackup(store){
  const payload = await createBackupPayload(store);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const ts = new Date().toISOString().replace(/[:.]/g,"").slice(0,15);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `speedlesen_${ts}_backup.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

export async function parseAndVerifyBackup(file){
  const text = await file.text();
  let obj; try{ obj = JSON.parse(text); } catch{ throw new Error("Ungültige JSON-Datei."); }
  if (!obj || obj.format!=="speedlesen.backup.v1" || !obj.data || !obj.hash) throw new Error("Falsches Backup-Format.");
  const core = JSON.stringify(obj.data);
  const hash = await sha256Hex(core);
  if (hash !== obj.hash) throw new Error("Integritätsprüfung fehlgeschlagen (Hash stimmt nicht).");
  return obj;
}

export async function restoreBackup(store, file, { overwrite=false }={}){
  const obj = await parseAndVerifyBackup(file);
  await store.importJSON(obj.data, { overwrite });
  return { ok:true, version: obj.dbVersion, exportedAt: obj.exportedAt };
}

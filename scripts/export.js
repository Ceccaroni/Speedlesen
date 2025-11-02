// CSV-Export (erweitert)
export function toCSV(rows){
  const header = ["Woche","Gruppe","Anzahl-Personen","Leser-Name","Wörter_3min","WPM","WPS","Fehler","WCPM (3-Min)","A_WPM_verbessert","B_Fehler_reduziert","Coaching","Mission","Punkte-Gruppe-Roh","Punkte-Gruppe-Normalisiert","Punkte-Gruppe-Kumuliert"];
  const esc = v => {
    const s = String(v==null?"":v);
    return /[",\n;]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
  const lines = [header.join(",")];
  for (const r of rows){
    lines.push([
      r.woche, r.gruppe, r.anzahl, r.name,
      r.woerter3, r.wpm, r.wps, r.fehler, r.wcpm,
      r.flagA, r.flagB, r.flagC, r.flagD,
      r.punkte_roh, r.punkte_norm, r.punkte_kum
    ].map(esc).join(","));
  }
  return lines.join("\n");
}

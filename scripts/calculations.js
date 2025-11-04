// Berechnungen gemäss neuer Spezifikation
export const calc = {
  // Umrechnungen
  // Eingabe: woerter3 (Wörter in 3 Minuten), fehler
  wpm(woerter3){ return (Number(woerter3)||0) / 3; },
  wps(woerter3){ return (Number(woerter3)||0) / 180; },

  // WCPM (3-Min) bleibt artefaktisch: (WPM - Fehler) / 3
  wcpm3(wpm, fehler){ return ((Number(wpm)||0) - (Number(fehler)||0)) / 3; },

  // Team-Punkte (A–D) ab Woche 2, max 10
  // prevPersons/currentPersons: Arrays mit {name,wpm,fehler,wcpm,...}
  teamPoints(prevPersons, currentPersons, coachingErfuellt, missionErfuellt, mode='standard'){
    // Map nach Name (Alias)
    const prevMap = new Map((prevPersons||[]).map(p=>[(p.pid||p.name), p]));
    let flagA = false; // WPM-Verbesserung bei mindestens 1 Person
    let flagB = false; // Fehlerreduktion bei mindestens 1 Person
    for (const c of (currentPersons||[])){
      const p = prevMap.get(c.pid || c.name);
      if (!p) continue;
      if ((c.wpm||0) > (p.wpm||0)) flagA = true;
      if ((c.fehler||0) < (p.fehler||0)) flagB = true;
    }
    const pointsA = flagA ? 2 : 0;
    const pointsB = flagB ? 3 : 0;
    const pointsC = (mode==='strikt') ? 0 : (coachingErfuellt ? 2 : 0);
    const pointsD = (mode==='strikt') ? 0 : (missionErfuellt ? 3 : 0);
    const roh = Math.min(10, pointsA + pointsB + pointsC + pointsD);
    return { roh, flagA, flagB, flagC: !!coachingErfuellt, flagD: !!missionErfuellt };
  },

  // Fair-Play Normalisierung auf Gruppengrösse 2
  normalizeTeamPoints(teamPointsRaw, countPersons){
    const n = Math.max(1, Number(countPersons)||1);
    return teamPointsRaw * (2 / n);
  },

  // Level (Gruppen-kumuliert, neue Grenzen)
  levelForCumulative(sum){
    const s = Number(sum)||0;
    if (s >= 30) return "Flow-Master";
    if (s >= 20) return "Speedster";
    if (s >= 10) return "Reader";
    return "Starter";
  },

  lastLevelUpWeek(weeks){
    const thresholds = [
      {level:"Reader", min:10},
      {level:"Speedster", min:20},
      {level:"Flow-Master", min:30},
    ];
    let cum = 0, lastWeek = 0, reached = new Set();
    const sorted = [...(weeks||[])].sort((a,b)=>a.woche-b.woche);
    for (const w of sorted){
      cum += Number(w.punkte_gruppe_normalisiert)||0;
      for (const t of thresholds){
        if (cum >= t.min && !reached.has(t.level)){
          reached.add(t.level);
          lastWeek = w.woche;
        }
      }
    }
    return lastWeek;
  },

  medianWcpmLastWeek(weeks){
    if (!weeks || weeks.length===0) return 0;
    const last = [...weeks].sort((a,b)=>b.woche-a.woche)[0];
    const arr = (last.personen||[]).map(p=> Number(p.wcpm)||0).filter(Number.isFinite);
    if (arr.length===0) return 0;
    arr.sort((a,b)=>a-b);
    const mid = Math.floor(arr.length/2);
    return arr.length%2 ? arr[mid] : (arr[mid-1]+arr[mid])/2;
  }
};

// --- Level-Basis (ohne Änderung am Punktesystem) ---------------------------
// basis: 'kumulativ' | '5w' | 'rang' | 'trend'
function levelScoreFromWeeks(weeks, basis = '5w') {
  // Wochen nach Nummer sortieren
  const ws = [...(weeks||[])].sort((a,b)=>a.woche-b.woche);
  const vals = ws.map(w => Number(w.punkte_gruppe_normalisiert || 0)); // 0..10

  let score = 0;

  if (basis === '5w' || basis === 'rang') {
    // Summe der letzten 5 Wochen → Skala 0..50 (anzeigelogik; Level-Schwellen bleiben 10/20/30)
    const last5 = vals.slice(-5);
    score = last5.reduce((a,b)=>a+b, 0);
  } else if (basis === 'trend' /* vormals 'egd' */) {
    // Exponentiell gleitend; Skala 0..10 -> hochskalieren auf 0..30 für Level
    const alpha = 0.4;
    let s = 0;
    for (const p of vals) s = alpha * p + (1 - alpha) * s;
    score = s * 3; // vergleichbar zu 0..30
  } else { // 'kumulativ'
    // Summe aller normierten Wochenpunkte → theoretisch >30 möglich
    score = vals.reduce((a,b)=>a+b, 0);
  }

  // Level aus Score nach 0–9 / 10–19 / 20–29 / ≥30
  let level = "Starter";
  if (score >= 30) level = "Flow-Master";
  else if (score >= 20) level = "Speedster";
  else if (score >= 10) level = "Reader";

  // Bound + nächster Schwellenwert für Fortschritt
  const lowerBound = (level==="Reader") ? 10 : (level==="Speedster") ? 20 : (level==="Flow-Master") ? 30 : 0;
  const nextThreshold = (level==="Flow-Master") ? null
                    : (level==="Speedster") ? 30
                    : (level==="Reader")   ? 20
                    : 10;

  // Fortschritt in % innerhalb der aktuellen 10er-Stufe
  const progress = (nextThreshold === null) ? 100
                  : Math.max(0, Math.min(100, ((score - lowerBound) / 10) * 100));

  return { score, level, lowerBound, nextThreshold, progress };
}

export const levelBasis = {
  fromWeeks: levelScoreFromWeeks
};

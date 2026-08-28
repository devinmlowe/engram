/**
 * Word frequency query functions for the word cloud visualizer.
 */

import type Database from "better-sqlite3";

// ─── Stop Words ─────────────────────────────────────────────────

export const STOP_WORDS = new Set([
  "the","be","to","of","and","a","in","that","have","i","it","for","not","on",
  "with","he","as","you","do","at","this","but","his","by","from","they","we",
  "say","her","she","or","an","will","my","one","all","would","there","their",
  "what","so","up","out","if","about","who","get","which","go","me","when",
  "make","can","like","time","no","just","him","know","take","people","into",
  "year","your","good","some","could","them","see","other","than","then","now",
  "look","only","come","its","over","think","also","back","after","use","two",
  "how","our","work","first","well","way","even","new","want","because","any",
  "these","give","day","most","us","is","are","was","were","been","being","has",
  "had","did","does","done","will","shall","should","may","might","must","can",
  "need","let","got","here","very","much","more","own","run","set","try","ask",
  "too","still","found","keep","last","long","made","sure","thing","going",
  "yes","no","ok","okay","right","yeah","hey","hi","hello","thanks","thank",
  "please","sorry","sure","great","actually","really","quite","pretty","etc",
  "using","used","file","files","code","tool","called","call","calls","command",
  "output","input","result","results","error","true","false","null","undefined",
  "let","const","var","function","return","import","export","default","class",
  "type","string","number","boolean","object","array","value","values","name",
  "path","data","list","read","write","create","update","delete","add","remove",
  "check","test","note","text","line","lines","run","start","end","src","http",
  "https","www","com","org","json","html","css","js","ts","md","yml","yaml",
  "png","jpg","txt","log","git","npm","node","usr","bin","etc","tmp","dev",
  "user","users","devinmlowe","teammate-message","summary","content","based",
  "should","current","don't","i'm","it's","that's","there's","what's","you're",
  "isn't","doesn't","didn't","won't","can't","couldn't","wouldn't","haven't",
  "hasn't","aren't","weren't","they're","we're","i've","you've","they've",
  "i'll","you'll","we'll","they'll","i'd","you'd","he'd","she'd","we'd",
  "assistant","message","messages","system","prompt","response","conversation",
  "context","token","tokens","model","models","already","specific","different",
  "working","look","looking","instead","need","needs","change","changes","show",
  "showing","ensure","existing","currently","without","available","following",
  "running","seems","relevant","approach","provide","provided","makes","making",
  "including","included","includes","correctly","correct","issue","issues",
  "information","example","process","version","configure","support","handle",
  "handling","handled","specify","specified","appropriate","complete","completed",
  "implement","implements","implementing","implementation","allow","allows",
  "allowed","possible","enable","enabled","confirm","execute","executing",
  "status","failed","success","pass","passing","passed","properly",
]);

// ─── Word Frequency Cache ───────────────────────────────────────

let wordCache: { words: Array<{ text: string; count: number }>; timestamp: number } | null = null;
// The WAL watcher invalidates on writes (resetWordCache); the TTL is only a
// fallback when the watcher is unavailable, so it no longer needs to be short
const WORD_CACHE_TTL = 10 * 60_000;

export function resetWordCache(): void {
  wordCache = null;
}

// ─── Word Frequency Query ───────────────────────────────────────

export function getWordFrequencies(db: Database.Database, limit = 300): Array<{ text: string; count: number }> {
  if (wordCache && Date.now() - wordCache.timestamp < WORD_CACHE_TTL) {
    return wordCache.words.slice(0, limit);
  }

  const rows = db
    .prepare("SELECT user_message FROM exchanges WHERE user_message IS NOT NULL")
    .all() as Array<{ user_message: string }>;

  const freq = new Map<string, number>();

  for (const row of rows) {
    const words = row.user_message
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && w.length < 25 && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !/^[a-f0-9]{8,}$/.test(w));

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const sorted = [...freq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)
    .map(([text, count]) => ({ text, count }));

  wordCache = { words: sorted, timestamp: Date.now() };
  return sorted.slice(0, limit);
}

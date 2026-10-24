import type { Plan } from "./plan";
import { songKey, type Take } from "./take";

/** Takes and practice plans live in IndexedDB on the device until downloaded and removed. */
const DB = "domiso";
const TAKES = "takes";
const PLANS = "plans";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) db.createObjectStore(TAKES, { keyPath: "id" }).createIndex("songKey", "songKey");
      if (e.oldVersion < 2) db.createObjectStore(PLANS, { keyPath: "id" }).createIndex("songKey", "songKey");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = f(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const saveTake = (take: Take) => run(TAKES, "readwrite", (s) => s.put(take)).then(() => {});
export const deleteTake = (id: string) => run(TAKES, "readwrite", (s) => s.delete(id)).then(() => {});

/** Takes of one song, newest first. */
export async function takesFor(key: string): Promise<Take[]> {
  const all = await run<Take[]>(TAKES, "readonly", (s) => s.index("songKey").getAll(key));
  return all.sort((a, b) => b.created.localeCompare(a.created));
}

/** Plans are stored with their song's key so they can be listed per song. */
export const savePlan = (plan: Plan) =>
  run(PLANS, "readwrite", (s) => s.put({ ...plan, songKey: songKey(plan.song) })).then(() => {});
export const deletePlan = (id: string) => run(PLANS, "readwrite", (s) => s.delete(id)).then(() => {});

/** Plans of one song, newest first. */
export async function plansFor(key: string): Promise<Plan[]> {
  const all = await run<(Plan & { songKey: string })[]>(PLANS, "readonly", (s) => s.index("songKey").getAll(key));
  return all
    .map(({ songKey: _k, ...p }) => p as Plan)
    .sort((a, b) => b.created.localeCompare(a.created));
}

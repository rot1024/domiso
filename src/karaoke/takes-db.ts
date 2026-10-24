import type { Take } from "./take";

/** Takes live in IndexedDB on the device until downloaded and removed. */
const DB = "domiso";
const STORE = "takes";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("songKey", "songKey");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = f(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const saveTake = (take: Take) => run("readwrite", (s) => s.put(take)).then(() => {});
export const deleteTake = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => {});
export const getTake = (id: string) => run<Take | undefined>("readonly", (s) => s.get(id));

/** Takes of one song, newest first. */
export async function takesFor(songKey: string): Promise<Take[]> {
  const all = await run<Take[]>("readonly", (s) => s.index("songKey").getAll(songKey));
  return all.sort((a, b) => b.created.localeCompare(a.created));
}

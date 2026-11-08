/**
 * Tiny promise wrapper around IndexedDB, shared by the background context and
 * the offscreen document (same extension origin → same databases).
 *
 * Object stores:
 *  - lists:     listId → CompiledListRecord (network rules, cosmetic data, popup data)
 *  - cosSpec:   hostname|entity → CosmeticEntry[] (merged index across enabled lists)
 *  - cosGen:    ".class"/"#id" token → selectors[] (merged low-generic index)
 *  - meta:      misc blobs (high-generic selectors, popup matcher, index version)
 *  - images:    url → cached ImageAnalysis
 *  - imageHash: sha256 → cached ImageAnalysis (dedupes the same image under different URLs)
 *  - models:    modelId → ArrayBuffer of the .onnx file
 */
const DB_NAME = 'cleanfeed';
const DB_VERSION = 1;
export const STORES = ['lists', 'cosSpec', 'cosGen', 'meta', 'images', 'imageHash', 'models'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another context upgrades the schema, drop our handle so it can proceed.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => {
      /* another context holds an old version open; onsuccess follows once released */
    };
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return promisify(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

/** Batched get: one transaction, results aligned with `keys`. */
export async function idbGetMany<T>(store: StoreName, keys: IDBValidKey[]): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const db = await openDb();
  const os = db.transaction(store, 'readonly').objectStore(store);
  return Promise.all(keys.map((k) => promisify(os.get(k)) as Promise<T | undefined>));
}

export async function idbPut(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txDone(tx);
}

export async function idbKeys(store: StoreName): Promise<IDBValidKey[]> {
  const db = await openDb();
  return promisify(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
}

export async function idbCount(store: StoreName): Promise<number> {
  const db = await openDb();
  return promisify(db.transaction(store, 'readonly').objectStore(store).count());
}

/**
 * Replaces the full contents of a store in chunked transactions. Large
 * single transactions can stall the service worker, so we commit in slices.
 */
export async function idbReplaceAll(
  store: StoreName,
  entries: Iterable<[IDBValidKey, unknown]>,
  chunkSize = 5000,
): Promise<void> {
  const db = await openDb();
  {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await txDone(tx);
  }
  let batch: [IDBValidKey, unknown][] = [];
  const flush = async () => {
    if (!batch.length) return;
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const [k, v] of batch) os.put(v, k);
    batch = [];
    await txDone(tx);
  };
  for (const e of entries) {
    batch.push(e);
    if (batch.length >= chunkSize) await flush();
  }
  await flush();
}

/** Deletes the oldest entries of a store whose values carry a numeric `t` timestamp. */
export async function idbPrune(store: StoreName, keep: number): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  const [keys, values] = await Promise.all([
    promisify(os.getAllKeys()),
    promisify(os.getAll()) as Promise<{ t?: number }[]>,
  ]);
  if (keys.length <= keep) return 0;
  const order = keys.map((k, i) => ({ k, t: values[i]?.t ?? 0 })).sort((a, b) => a.t - b.t);
  const drop = order.slice(0, keys.length - keep);
  const wtx = db.transaction(store, 'readwrite');
  const wos = wtx.objectStore(store);
  for (const d of drop) wos.delete(d.k);
  await txDone(wtx);
  return drop.length;
}

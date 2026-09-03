const DATABASE_NAME = "tokenpath-saved-attribution-cases";
const DATABASE_VERSION = 1;
const STORE_NAME = "cases";
const SAVED_AT_INDEX = "savedAt";

export interface SavedAttributionCase {
  schemaVersion: 1;
  id: string;
  savedAt: string;
  updatedAt: string;
  note: string;
  source: {
    url: string | null;
    label: string;
    sourceType: string;
  };
  attributionRequest: {
    method: "POST";
    path: "/v1/attributions";
    body: {
      document: string;
      question: string;
      answer: string;
    };
  };
  attributionResponse:
    | {
        status: "ready";
        offsetEncoding: "utf-16";
        spans: TokenPathAttributionSpan[];
      }
    | {
        status: "error";
        error: string;
      };
}

export interface SavedAttributionCasesExport {
  schemaVersion: 1;
  exportedAt: string;
  app: {
    name: string;
    version: string;
  };
  cases: SavedAttributionCase[];
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () =>
      reject(request.error || new Error("Couldn't open saved cases."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE_NAME)) return;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex(SAVED_AT_INDEX, "savedAt");
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      let result: T | undefined;
      request.onerror = () =>
        reject(request.error || new Error("Saved case request failed."));
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result as T);
      transaction.onabort = () =>
        reject(transaction.error || new Error("Saved case request failed."));
    });
  } finally {
    database.close();
  }
}

export async function readSavedAttributionCases() {
  const cases = await withStore<SavedAttributionCase[]>("readonly", (store) =>
    store.getAll()
  );
  return cases.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

export async function writeSavedAttributionCase(
  savedCase: SavedAttributionCase
) {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(savedCase));
}

export async function deleteSavedAttributionCase(id: string) {
  await withStore<undefined>("readwrite", (store) => store.delete(id));
}

export function buildSavedAttributionCasesExport(
  cases: SavedAttributionCase[]
): SavedAttributionCasesExport {
  const manifest = chrome.runtime.getManifest();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: {
      name: manifest.name,
      version: manifest.version,
    },
    cases,
  };
}

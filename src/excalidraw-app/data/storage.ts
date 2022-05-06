import { ExcalidrawElement, FileId } from "../../element/types";
import { getSceneVersion } from "../../element";
import Portal from "../collab/Portal";
import { restoreElements } from "../../data/restore";
import {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../types";
import { decompressData } from "../../data/encode";
import { decryptData, encryptData } from "../../data/encryption";
import { MIME_TYPES } from "../../constants";
import { reconcileElements } from "../collab/reconciliation";
//import Keyv from 'keyv';

// private
// -----------------------------------------------------------------------------
let MONGO_CONFIG: Record<string, any>;
try {
  MONGO_CONFIG = JSON.parse(process.env.REACT_APP_MONGO_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing mongo config. Supplied value: ${process.env.REACT_APP_MONGO_CONFIG}`,
  );
  MONGO_CONFIG = {};
}

let isFirebaseInitialized = false;
let client: Promise<any> | null = null;

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  if (!client) {
    const uri = MONGO_CONFIG.uri;
    console.warn(uri);
    isFirebaseInitialized = true;
    //client = Promise.resolve(new Keyv(uri));
    client = Promise.resolve(null);
    return client;
  }
  return client;
};

interface StoredScene {
  sceneVersion: number;
  iv: Blob;
  ciphertext: Blob;
}

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = await data.ciphertext.arrayBuffer();
  const iv = new Uint8Array(await data.iv.arrayBuffer());

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const firebaseSceneVersionCache = new WeakMap<SocketIOClient.Socket, number>();

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return firebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
                                            prefix,
                                            files,
                                          }: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  console.warn("DISABLED saveFilesToFirebase");
  //const firebase = await loadFirebaseStorage();

  const erroredFiles = new Map<FileId, true>();
  const savedFiles = new Map<FileId, true>();

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      erroredFiles.set(id, true);
      /*
      try {
        await firebase.set(`${prefix}/${id}`, new Blob([buffer], { type: MIME_TYPES.binary }));
        savedFiles.set(id, true);
      } catch (error: any) {
        erroredFiles.set(id, true);
      }
      */
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly ExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: new Blob([ciphertext], { type: MIME_TYPES.binary }),
    iv: new Blob([iv], { type: MIME_TYPES.binary }),
  } as StoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) => {
  console.warn("DISABLED saveToFirebase");
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return false;
  }

  return false;
  /*
  const firebase: Keyv = await loadFirebaseStorage();

  const snapshot = await firebase.get(`scenes/${roomId}`);
  if (!snapshot || !snapshot.exists) {
    const sceneDocument = await createFirebaseSceneDocument(
      elements,
      roomKey,
    );

    await firebase.set(`scenes/${roomId}`, sceneDocument);
    return {
      sceneVersion: sceneDocument.sceneVersion,
      reconciledElements: null,
    };
  } else {
    const prevDocData = snapshot as StoredScene;
    const prevElements = await decryptElements(prevDocData, roomKey);

    const reconciledElements = reconcileElements(
      elements,
      prevElements,
      appState,
    );

    const sceneDocument = await createFirebaseSceneDocument(
      reconciledElements,
      roomKey,
    );

    await firebase.set(`scenes/${roomId}`, sceneDocument);
    firebaseSceneVersionCache.set(socket, sceneDocument.sceneVersion);
    return {
      reconciledElements,
      sceneVersion: sceneDocument.sceneVersion,
    };
  }*/
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: SocketIOClient.Socket | null,
): Promise<readonly ExcalidrawElement[] | null> => {
  console.warn("DISABLED loadFromFirebase");
  return null;
  /*
  const client : Keyv = await loadFirebaseStorage();
  const snapshot = await client.get(`scenes/${roomId}`);
  if (!snapshot || !snapshot.exists) {
    return null;
  }
  const storedScene = snapshot as StoredScene;
  const elements = await decryptElements(storedScene, roomKey);
  if (socket) {
    firebaseSceneVersionCache.set(socket, getSceneVersion(elements));
  }
  return restoreElements(elements, null);
  */
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  console.warn("DISABLED loadFilesFromFirebase");
  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        /*
        const client : Keyv = await loadFirebaseStorage();
        const file = await client.get(`${prefix}/${id}`);
        if (file) {
          const blob = file.data as Blob;
          const arrayBuffer = await blob.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;
          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
        */
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

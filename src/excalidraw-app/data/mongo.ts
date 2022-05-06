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
import { MongoClient } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";

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
let client: Promise<MongoClient> | null = null;

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  if (!client) {
    const uri = MONGO_CONFIG.uri;
    console.warn(uri);
    isFirebaseInitialized = true;

    try {
      const connection = new ConnectionString(uri);
      console.warn(connection.toString());
    } catch (error) {
      console.error("failed to create connection string");
    }

    const c = new MongoClient(uri);
    client = c.connect();
  }
  return client;
};

interface FirebaseStoredScene {
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
  data: FirebaseStoredScene,
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
  const firebase = await loadFirebaseStorage();

  const erroredFiles = new Map<FileId, true>();
  const savedFiles = new Map<FileId, true>();

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        await firebase
          .db("excalidraw-store")
          .collection("files")
          .insertOne({
            ref: `${prefix}/${id}`,
            data: new Blob([buffer], { type: MIME_TYPES.binary }),
          });
        savedFiles.set(id, true);
      } catch (error: any) {
        erroredFiles.set(id, true);
      }
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
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) => {
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

  const client = await loadFirebaseStorage();

  const scenes = client.db("excalidraw-store").collection("scenes");
  const session = client.startSession();
  try {
    session.startTransaction({
      maxCommitTimeMS: 1000,
    });

    const snapshot = await scenes.findOne({ room: roomId });

    if (!snapshot || !snapshot.exists) {
      const sceneDocument = await createFirebaseSceneDocument(
        elements,
        roomKey,
      );

      await scenes.insertOne({ room: roomId, data: sceneDocument });
      await session.commitTransaction();
      return {
        sceneVersion: sceneDocument.sceneVersion,
        reconciledElements: null,
      };
    }

    const prevDocData = snapshot.data as FirebaseStoredScene;
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

    await scenes.updateOne({ room: roomId }, { $set: { data: sceneDocument } });

    firebaseSceneVersionCache.set(socket, sceneDocument.sceneVersion);

    await session.commitTransaction();

    return {
      reconciledElements,
      sceneVersion: sceneDocument.sceneVersion,
    };
  } catch (error) {
    await session.abortTransaction();
  } finally {
    await session.endSession();
  }
  return null;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: SocketIOClient.Socket | null,
): Promise<readonly ExcalidrawElement[] | null> => {
  const client = await loadFirebaseStorage();
  const scenes = client.db("excalidraw-store").collection("scenes");
  const snapshot = await scenes.findOne({ room: roomId });

  if (!snapshot || !snapshot.exists) {
    return null;
  }
  const storedScene = snapshot.data as FirebaseStoredScene;
  const elements = await decryptElements(storedScene, roomKey);

  if (socket) {
    firebaseSceneVersionCache.set(socket, getSceneVersion(elements));
  }

  return restoreElements(elements, null);
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const client = await loadFirebaseStorage();
        const files = client.db("excalidraw-store").collection("store");
        const file = await files.findOne({ ref: `${prefix}/${id}` });
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
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

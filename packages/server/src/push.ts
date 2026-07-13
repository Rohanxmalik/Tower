import webpush from "web-push";
import type { DelegatedTask } from "@tower/shared";
import type { TowerStore } from "./store/sqlite.js";

/**
 * Web push for the board: when a worker parks a task for approval, every browser
 * that opted in ("Notify me" on /board) gets a notification — the phone buzzes
 * without the board tab being open. VAPID keys are generated once per server and
 * persisted in the kv table so subscriptions survive restarts.
 */

const VAPID_KV_KEY = "vapid-keys";

/** Contact for push services; VAPID requires a subject URL or mailto. */
const VAPID_SUBJECT = "https://github.com/Rohanxmalik/Tower";

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}

/** Load the server's VAPID key pair, generating and persisting it on first use. */
export function ensureVapidKeys(
  store: TowerStore,
  generate: () => PushKeys = () => webpush.generateVAPIDKeys(),
): PushKeys {
  const raw = store.getKv(VAPID_KV_KEY);
  if (raw) return JSON.parse(raw) as PushKeys;
  const keys = generate();
  store.setKv(VAPID_KV_KEY, JSON.stringify(keys));
  return keys;
}

/** Sends one encrypted push message to one subscription. Injectable for tests. */
export type PushSender = (subJson: string, payload: string, keys: PushKeys) => Promise<void>;

const defaultSender: PushSender = async (subJson, payload, keys) => {
  await webpush.sendNotification(JSON.parse(subJson) as webpush.PushSubscription, payload, {
    vapidDetails: {
      subject: VAPID_SUBJECT,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
  });
};

/**
 * Notify every subscribed browser that a task is waiting for a human tap.
 * Endpoints that bounce 404/410 (browser uninstalled / subscription expired) are
 * dropped; transient failures are ignored — push is best-effort by design.
 */
export async function sendApprovalPush(
  store: TowerStore,
  keys: PushKeys,
  task: DelegatedTask,
  sender: PushSender = defaultSender,
): Promise<void> {
  const payload = JSON.stringify({
    title: "Tower: task needs your OK",
    body: `${task.fromAgentId} → ${task.toAgentId}: ${task.body.slice(0, 120)}`,
    tag: task.id,
  });
  await Promise.all(
    store.listPushSubs().map(async ({ endpoint, sub }) => {
      try {
        await sender(sub, payload, keys);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) store.deletePushSub(endpoint);
      }
    }),
  );
}

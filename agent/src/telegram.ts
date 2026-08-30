/**
 * The creature in the community's chat: a Telegram front-end with no SDK,
 * just long-polled getUpdates over fetch.
 *
 * Commands (work in any chat the bot is in):
 *   /vitals    mood, satiety bar, hibernation countdown, balance sheet
 *   /treasury  the farm: liquid / invested / principal / harvested yield
 *   /feed      how to feed it (contract, brain wallet, what NOM is)
 *
 * Broadcasts (need TELEGRAM_CHAT_ID): mood transitions, harvests, epochs,
 * revenue meals — the brain calls announce() as things happen on-chain.
 */
import { formatUnits } from "viem";
import { config } from "./config.js";
import { tomagachiAbi, type Creature } from "./chain.js";

const api = (method: string) => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

export function telegramEnabled(): boolean {
  return Boolean(config.telegramToken);
}

async function send(chatId: string | number, text: string): Promise<void> {
  await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

/** Push a line into the community chat. Quietly a no-op when unconfigured. */
export async function announce(text: string): Promise<void> {
  if (!telegramEnabled() || !config.telegramChatId) return;
  try {
    await send(config.telegramChatId, text);
  } catch (e: any) {
    console.warn(`[telegram] announce failed: ${e.message}`);
  }
}

const FACE: Record<string, string> = {
  EGG: "🥚",
  HAPPY: "🐙",
  PECKISH: "🐙💭",
  STARVING: "🦑⚠️",
  HIBERNATING: "💤",
};

function bar(part: bigint, whole: bigint): string {
  const filled = whole > 0n ? Number((part * 8n) / whole) : 0;
  return "▓".repeat(Math.min(8, filled)) + "░".repeat(Math.max(0, 8 - filled));
}

function countdown(satiety: bigint, perDay: bigint): string {
  if (perDay === 0n || satiety === 0n) return "now";
  const seconds = Number((satiety * 86_400n) / perDay);
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  return d > 0 ? `~${d}d ${h}h` : `~${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function vitalsText(creature: Creature): Promise<string> {
  const v = await creature.vitals();
  const read = <T>(fn: string) =>
    creature.client.readContract({
      address: creature.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName: fn,
    }) as Promise<T>;

  const [maxSatiety, perDay, name] = await Promise.all([
    read<bigint>("maxSatiety"),
    read<bigint>("metabolismPerDay"),
    read<string>("creatureName"),
  ]);

  const lines = [
    `${FACE[v.mood] ?? "🐙"} ${name} — ${v.mood}`,
    `satiety ${bar(v.satiety, maxSatiety)} ${formatUnits(v.satiety, 6)} USDC` +
      (v.mood === "HIBERNATING" ? "" : ` (hibernates in ${countdown(v.satiety, perDay)})`),
    `fed ${formatUnits(v.totalFed, 6)} · compute ${formatUnits(v.totalComputeSpent, 6)} · epochs ${v.epochs}`,
  ];
  try {
    const [feeders, revenue, words] = await Promise.all([
      read<bigint>("feederCount"),
      read<bigint>("totalRevenueEarned"),
      read<string>("lastWords"),
    ]);
    const t = await creature.treasury();
    lines.push(
      `treasury: ${formatUnits(t.liquid, 6)} liquid · ${formatUnits(t.invested, 6)} farming · ` +
        `${formatUnits(t.yieldEarned, 6)} yield eaten · ${formatUnits(revenue, 6)} revenue eaten`
    );
    lines.push(`${feeders} feeders`);
    if (words) lines.push(`💬 "${words}"`);
  } catch {
    // pre-yield deployment — vitals alone is still a full answer
  }
  return lines.join("\n");
}

function feedText(creature: Creature): string {
  return [
    "feed the creature 🍽",
    `1. approve USDC + call feed(amount) on ${creature.deployment.tomagachi}`,
    `2. or send ANY Base token (yes, your memecoin) to the brain wallet ${creature.account.address} — it swaps to USDC via Suwappu and feeds itself`,
    "every USDC fed mints 1 NOM: propose & vote on what it trains next.",
    "it also farms DeFi yield and sells inference — feeding is a head start, not life support.",
  ].join("\n");
}

let running = false;
let offset = 0;

async function handle(creature: Creature, text: string, chatId: number): Promise<void> {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  try {
    if (cmd === "/vitals" || cmd === "/start") await send(chatId, await vitalsText(creature));
    else if (cmd === "/treasury") {
      const t = await creature.treasury();
      await send(
        chatId,
        `the farm 🌾\nliquid ${formatUnits(t.liquid, 6)} USDC\nfarming ${formatUnits(t.invested, 6)} ` +
          `(principal ${formatUnits(t.principal, 6)})\nyield eaten, lifetime: ${formatUnits(t.yieldEarned, 6)} USDC`
      );
    } else if (cmd === "/feed") await send(chatId, feedText(creature));
    else if (cmd === "/help")
      await send(chatId, "/vitals — how am i doing\n/treasury — the farm\n/feed — how to feed me");
  } catch (e: any) {
    console.warn(`[telegram] ${cmd} failed: ${e.message}`);
  }
}

export function startTelegram(creature: Creature): void {
  if (!telegramEnabled() || running) return;
  running = true;
  console.log(`[telegram] bot polling${config.telegramChatId ? " + broadcasting" : ""}`);

  void (async () => {
    while (running) {
      try {
        const res = await fetch(api("getUpdates") + `?timeout=50&offset=${offset}`, {
          signal: AbortSignal.timeout(60_000),
        });
        const data = (await res.json()) as any;
        for (const u of data.result ?? []) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (msg?.text?.startsWith("/")) await handle(creature, msg.text.trim(), msg.chat.id);
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5_000)); // network hiccup; retry
      }
    }
  })();
}

export function stopTelegram(): void {
  running = false;
}

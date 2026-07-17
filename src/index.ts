import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

const PLUGIN_ID = "restricted-reminders";
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { Lunar } = require("lunar-javascript") as {
  Lunar: {
    fromYmd: (year: number, month: number, day: number, leapMonth?: boolean) => {
      getSolar: () => { getYear: () => number; getMonth: () => number; getDay: () => number; toYmd: () => string };
    };
  };
};
const DEFAULT_ALLOWED_CHANNELS = [
  "feishu",
  "lark",
  "openclaw-lark",
  "openclaw-feishu",
  "weixin",
  "wechat",
  "openclaw-weixin",
  "openclaw-wechat",
  "dingtalk",
  "dingding",
  "openclaw-dingtalk",
  "lightclawbot",
  "openclaw-lightclawbot",
];
const DEFAULT_LUNAR_YEARS_AHEAD = 10;

const configSchema = Type.Object({
  allowedChannels: Type.Optional(
    Type.Array(Type.String(), {
      description: "Channel ids where restricted reminder tools are exposed.",
    }),
  ),
  defaultTimezone: Type.Optional(
    Type.String({
      description: "Default IANA timezone used for recurring reminders.",
    }),
  ),
  maxRemindersPerUser: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: "Maximum active reminders one sender can own.",
    }),
  ),
  minDelayMinutes: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1440,
      description: "Minimum delay for one-shot reminders.",
    }),
  ),
  lunarYearsAhead: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 30,
      description: "How many future lunar-yearly occurrences to pre-schedule.",
    }),
  ),
  openclawCommand: Type.Optional(
    Type.String({
      description:
        "Optional OpenClaw CLI command or JS entry used as fallback when plugin scheduler APIs are unavailable.",
    }),
  ),
});

type PluginConfig = {
  allowedChannels?: string[];
  defaultTimezone?: string;
  maxRemindersPerUser?: number;
  minDelayMinutes?: number;
  lunarYearsAhead?: number;
  openclawCommand?: string;
};

type DurationParts = {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
};

type ReminderSchedule =
  | { kind: "once"; at?: string; delayMinutes?: number; delaySeconds?: number; duration?: DurationParts }
  | { kind: "interval"; everyMinutes?: number; everySeconds?: number; duration?: DurationParts; timezone?: string }
  | { kind: "daily"; time: string; timezone?: string }
  | { kind: "weekdays"; time: string; timezone?: string }
  | { kind: "weekly"; dayOfWeek: number; time: string; timezone?: string }
  | { kind: "monthly"; dayOfMonth: number; time: string; timezone?: string }
  | { kind: "yearly"; month: number; dayOfMonth: number; time: string; timezone?: string }
  | {
      kind: "lunarOnce";
      lunarMonth: number;
      lunarDay: number;
      time: string;
      leapMonth?: boolean;
      timezone?: string;
    }
  | {
      kind: "lunarYearly";
      lunarMonth: number;
      lunarDay: number;
      time: string;
      leapMonth?: boolean;
      timezone?: string;
      yearsAhead?: number;
    };

type ReminderRecord = {
  id: string;
  userKey: string;
  channel: string;
  accountId?: string;
  senderId: string;
  sessionKey: string;
  sessionId?: string;
  tag: string;
  schedulerJobId?: string;
  schedulerJobIds?: string[];
  title: string;
  message: string;
  schedule: ReminderSchedule;
  displaySchedule: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "cancelled";
};

type ReminderStore = {
  version: 1;
  reminders: ReminderRecord[];
};

type Identity = {
  userKey: string;
  channel: string;
  accountId?: string;
  senderId: string;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
};

type SchedulerApi = {
  session: {
    workflow: {
      scheduleSessionTurn?: (params: any) => Promise<{ id: string } | undefined>;
      unscheduleSessionTurnsByTag?: (params: any) => Promise<{ removed: number; failed: number }>;
    };
  };
};

type HostParams = {
  at?: Date;
  delayMs?: number;
  cron?: string;
  tz?: string;
  every?: string;
  deleteAfterRun?: boolean;
};

const durationSchema = Type.Object({
  days: Type.Optional(Type.Integer({ minimum: 0, maximum: 366 })),
  hours: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 59 })),
  seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 59 })),
});

const scheduleSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("once"),
    at: Type.Optional(
      Type.String({
        description:
          "Absolute ISO datetime. Include timezone offset when possible.",
      }),
    ),
    delayMinutes: Type.Optional(
      Type.Number({
        minimum: 0,
        description: "Delay from now, in minutes. Prefer duration for mixed day/hour/minute/second requests.",
      }),
    ),
    delaySeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Delay from now, in seconds.",
      }),
    ),
    duration: Type.Optional(durationSchema),
  }),
  Type.Object({
    kind: Type.Literal("interval"),
    everyMinutes: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 525600,
      description: "Repeat every N minutes, for example everyMinutes=2.",
    })),
    everySeconds: Type.Optional(Type.Integer({
      minimum: 60,
      maximum: 31536000,
      description: "Repeat every N seconds. Minimum is 60 seconds.",
    })),
    duration: Type.Optional(durationSchema),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("daily"),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 22:30.",
    }),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("weekdays"),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 09:00.",
    }),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("weekly"),
    dayOfWeek: Type.Integer({
      minimum: 0,
      maximum: 6,
      description: "0 is Sunday, 1 is Monday, ... 6 is Saturday.",
    }),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 09:00.",
    }),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("monthly"),
    dayOfMonth: Type.Integer({
      minimum: 1,
      maximum: 31,
      description: "Calendar day in the month. Months without this day are skipped by cron.",
    }),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 09:58.",
    }),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("yearly"),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    dayOfMonth: Type.Integer({ minimum: 1, maximum: 31 }),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 09:58.",
    }),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("lunarOnce"),
    lunarMonth: Type.Integer({ minimum: 1, maximum: 12 }),
    lunarDay: Type.Integer({ minimum: 1, maximum: 30 }),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 11:00.",
    }),
    leapMonth: Type.Optional(Type.Boolean()),
    timezone: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("lunarYearly"),
    lunarMonth: Type.Integer({ minimum: 1, maximum: 12 }),
    lunarDay: Type.Integer({ minimum: 1, maximum: 30 }),
    time: Type.String({
      pattern: "^\\d{1,2}:\\d{2}$",
      description: "24-hour local time, for example 09:58.",
    }),
    leapMonth: Type.Optional(Type.Boolean()),
    timezone: Type.Optional(Type.String()),
    yearsAhead: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  }),
]);

const addSchema = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: 120,
    description: "Short reminder title shown in list/cancel results.",
  }),
  message: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "The exact future agent task/reminder text. Include relevant context such as stock symbols.",
  }),
  schedule: scheduleSchema,
});

const removeSchema = Type.Object({
  idOrTitle: Type.String({
    minLength: 1,
    maxLength: 160,
    description:
      "Reminder id or title text. If a title matches multiple reminders, the tool asks for a more specific id.",
  }),
});

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? null,
  };
}

function normalizeConfig(config: PluginConfig) {
  return {
    allowedChannels:
      config.allowedChannels?.map(normalizeChannelKey).filter(Boolean) ??
      DEFAULT_ALLOWED_CHANNELS,
    defaultTimezone: config.defaultTimezone?.trim() || "Asia/Shanghai",
    maxRemindersPerUser: config.maxRemindersPerUser ?? 20,
    minDelayMinutes: config.minDelayMinutes ?? 1,
    lunarYearsAhead: config.lunarYearsAhead ?? DEFAULT_LUNAR_YEARS_AHEAD,
    openclawCommand: config.openclawCommand?.trim() || undefined,
  };
}

function trimString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeChannelKey(channel: string) {
  return channel.trim().toLowerCase();
}

function channelAliases(channel: string) {
  const normalized = normalizeChannelKey(channel);
  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith("openclaw-")) {
    aliases.add(normalized.slice("openclaw-".length));
  } else {
    aliases.add(`openclaw-${normalized}`);
  }

  if (["feishu", "lark", "openclaw-feishu", "openclaw-lark"].includes(normalized)) {
    aliases.add("feishu");
    aliases.add("lark");
    aliases.add("openclaw-feishu");
    aliases.add("openclaw-lark");
  }
  if (["weixin", "wechat", "openclaw-weixin", "openclaw-wechat"].includes(normalized)) {
    aliases.add("weixin");
    aliases.add("wechat");
    aliases.add("openclaw-weixin");
    aliases.add("openclaw-wechat");
  }
  if (["dingtalk", "dingding", "openclaw-dingtalk"].includes(normalized)) {
    aliases.add("dingtalk");
    aliases.add("dingding");
    aliases.add("openclaw-dingtalk");
  }
  if (["lightclawbot", "lightclaw-bot", "openclaw-lightclawbot"].includes(normalized)) {
    aliases.add("lightclawbot");
    aliases.add("lightclaw-bot");
    aliases.add("openclaw-lightclawbot");
  }
  return [...aliases];
}

function resolveContextChannel(ctx: OpenClawPluginToolContext) {
  const raw = ctx as Record<string, any>;
  const sessionKey = resolveContextSessionKey(ctx);
  return firstString(
    ctx.messageChannel,
    raw.messageProvider,
    raw.currentChannelProvider,
    raw.channelProvider,
    raw.channel,
    raw.toolContext?.messageProvider,
    raw.toolContext?.currentChannelProvider,
    raw.deliveryContext?.messageChannel,
    raw.deliveryContext?.messageProvider,
    raw.deliveryContext?.currentChannelProvider,
    parseSessionKey(sessionKey)?.channel,
  );
}

function resolveContextSessionKey(ctx: OpenClawPluginToolContext) {
  const raw = ctx as Record<string, any>;
  return firstString(
    ctx.sessionKey,
    raw.currentSessionKey,
    raw.conversationSessionKey,
    raw.policySessionKey,
    raw.runSessionKey,
    raw.toolContext?.sessionKey,
    raw.toolContext?.currentSessionKey,
    raw.deliveryContext?.sessionKey,
    raw.deliveryContext?.policySessionKey,
  );
}

function parseSessionKey(sessionKey?: string) {
  if (!sessionKey) {
    return null;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 4) {
    return null;
  }
  const channelIndex = parts.findIndex((part) => channelAliases(part).some((alias) => DEFAULT_ALLOWED_CHANNELS.includes(alias)));
  if (channelIndex < 0 || channelIndex >= parts.length - 1) {
    return null;
  }
  return {
    channel: parts[channelIndex],
    senderId: parts.slice(channelIndex + 1).join(":"),
  };
}

export function resolveIdentity(ctx: OpenClawPluginToolContext): Identity | null {
  const raw = ctx as Record<string, any>;
  const sessionKey = resolveContextSessionKey(ctx);
  const sessionIdentity = parseSessionKey(sessionKey);
  const channel = resolveContextChannel(ctx);
  const senderId = firstString(
    ctx.requesterSenderId,
    raw.senderId,
    raw.currentSenderId,
    raw.fromUserId,
    raw.userId,
    raw.requester?.senderId,
    raw.message?.senderId,
    raw.toolContext?.requesterSenderId,
    raw.toolContext?.senderId,
    raw.deliveryContext?.requesterSenderId,
    raw.deliveryContext?.senderId,
    sessionIdentity?.senderId,
  );
  if (!channel || !senderId || !sessionKey) {
    return null;
  }
  const normalizedChannel = normalizeChannelKey(channel);
  const accountId = firstString(
    ctx.agentAccountId,
    raw.accountId,
    raw.currentAccountId,
    raw.agentAccountId,
    raw.toolContext?.agentAccountId,
    raw.deliveryContext?.accountId,
  );
  const userKey = [normalizedChannel, accountId ?? "default", senderId].join("|");
  return {
    userKey,
    channel: normalizedChannel,
    accountId,
    senderId,
    sessionKey,
    sessionId: firstString(ctx.sessionId, raw.currentSessionId, raw.toolContext?.sessionId),
    agentId: firstString(ctx.agentId, raw.currentAgentId, raw.toolContext?.agentId),
  };
}

function isAllowedChannel(channel: string, config: PluginConfig) {
  const allowed = new Set(normalizeConfig(config).allowedChannels.map(normalizeChannelKey));
  return channelAliases(channel).some((alias) => allowed.has(alias));
}

function isAllowedIdentity(identity: Identity, config: PluginConfig) {
  return isAllowedChannel(identity.channel, config);
}

export function shouldExposeReminderTools(ctx: OpenClawPluginToolContext, config: PluginConfig) {
  const identity = resolveIdentity(ctx);
  if (identity) {
    return isAllowedIdentity(identity, config);
  }
  const channel = resolveContextChannel(ctx);
  return !channel || isAllowedChannel(channel, config);
}

function requireAllowedIdentity(ctx: OpenClawPluginToolContext, config: PluginConfig) {
  const identity = resolveIdentity(ctx);
  if (!identity) {
    throw new Error("当前渠道缺少可信发送者身份，无法安全创建或管理提醒。");
  }
  if (!isAllowedIdentity(identity, config)) {
    throw new Error(`当前渠道 ${identity.channel} 未启用提醒权限。`);
  }
  return identity;
}

function resolveStorePath() {
  const home = process.env.OPENCLAW_HOME || join(process.env.HOME || tmpdir(), ".openclaw");
  return join(home, "state", PLUGIN_ID, "reminders.json");
}

async function readStore(): Promise<ReminderStore> {
  const path = resolveStorePath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReminderStore>;
    return {
      version: 1,
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, reminders: [] };
    }
    throw error;
  }
}

async function writeStore(store: ReminderStore) {
  const path = resolveStorePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function parseClockTime(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    throw new Error(`Invalid time "${time}". Use HH:mm, for example 22:30.`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new Error(`Invalid time "${time}". Use a 24-hour HH:mm value.`);
  }
  return { hour, minute };
}

function durationToMs(duration: DurationParts) {
  const days = duration.days ?? 0;
  const hours = duration.hours ?? 0;
  const minutes = duration.minutes ?? 0;
  const seconds = duration.seconds ?? 0;
  const total =
    days * 24 * 60 * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Duration must be greater than zero.");
  }
  return total;
}

function msToDurationParts(ms: number): Required<DurationParts> {
  let remaining = Math.ceil(ms / 1000);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  return { days, hours, minutes, seconds };
}

function formatDuration(duration: DurationParts) {
  const parts = [
    duration.days ? `${duration.days}d` : "",
    duration.hours ? `${duration.hours}h` : "",
    duration.minutes ? `${duration.minutes}m` : "",
    duration.seconds ? `${duration.seconds}s` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("") : "0s";
}

function formatDurationMs(ms: number) {
  return formatDuration(msToDurationParts(ms));
}

function formatCliDurationMs(ms: number) {
  return `${Math.ceil(ms / 1000)}s`;
}

function resolveOnceDelayMs(schedule: Extract<ReminderSchedule, { kind: "once" }>) {
  if (schedule.duration) {
    return durationToMs(schedule.duration);
  }
  if (schedule.delaySeconds !== undefined) {
    return schedule.delaySeconds * 1000;
  }
  if (schedule.delayMinutes !== undefined) {
    return schedule.delayMinutes * 60_000;
  }
  return undefined;
}

function resolveIntervalMs(schedule: Extract<ReminderSchedule, { kind: "interval" }>) {
  if (schedule.duration) {
    return durationToMs(schedule.duration);
  }
  if (schedule.everySeconds !== undefined) {
    return schedule.everySeconds * 1000;
  }
  if (schedule.everyMinutes !== undefined) {
    return schedule.everyMinutes * 60_000;
  }
  throw new Error("Interval reminders need duration, everySeconds, or everyMinutes.");
}

function localIso(year: number, month: number, day: number, time: string, timezone: string) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("Absolute generated dates currently require Asia/Shanghai timezone.");
  }
  const { hour, minute } = parseClockTime(time);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  return new Date(`${year}-${mm}-${dd}T${hh}:${mi}:00+08:00`);
}

function lunarToSolarDate(
  lunarYear: number,
  lunarMonth: number,
  lunarDay: number,
  time: string,
  timezone: string,
  leapMonth = false,
) {
  const solar = Lunar.fromYmd(lunarYear, lunarMonth, lunarDay, leapMonth).getSolar();
  return {
    at: localIso(solar.getYear(), solar.getMonth(), solar.getDay(), time, timezone),
    display: `${solar.toYmd()} ${time}`,
  };
}

function lunarOnceHost(
  schedule: Extract<ReminderSchedule, { kind: "lunarOnce" }>,
  config: PluginConfig,
): { host: HostParams; displayDate: string; timezone: string } {
  const normalized = normalizeConfig(config);
  const timezone = schedule.timezone?.trim() || normalized.defaultTimezone;
  const currentYear = new Date().getFullYear();
  for (const lunarYear of [currentYear, currentYear + 1]) {
    const resolved = lunarToSolarDate(
      lunarYear,
      schedule.lunarMonth,
      schedule.lunarDay,
      schedule.time,
      timezone,
      schedule.leapMonth ?? false,
    );
    if (resolved.at.getTime() > Date.now()) {
      return {
        host: { at: resolved.at, deleteAfterRun: true },
        displayDate: resolved.display,
        timezone,
      };
    }
  }
  throw new Error("Could not resolve a future lunar occurrence.");
}

function lunarYearlyHosts(
  schedule: Extract<ReminderSchedule, { kind: "lunarYearly" }>,
  config: PluginConfig,
): { hosts: HostParams[]; displayDates: string[]; timezone: string } {
  const normalized = normalizeConfig(config);
  const timezone = schedule.timezone?.trim() || normalized.defaultTimezone;
  const currentYear = new Date().getFullYear();
  const yearsAhead = schedule.yearsAhead ?? normalized.lunarYearsAhead;
  const hosts: HostParams[] = [];
  const displayDates: string[] = [];
  for (let offset = 0; offset < yearsAhead; offset += 1) {
    const lunarYear = currentYear + offset;
    const resolved = lunarToSolarDate(
      lunarYear,
      schedule.lunarMonth,
      schedule.lunarDay,
      schedule.time,
      timezone,
      schedule.leapMonth ?? false,
    );
    const at = resolved.at;
    if (at.getTime() <= Date.now()) {
      continue;
    }
    hosts.push({ at, deleteAfterRun: true });
    displayDates.push(resolved.display);
  }
  if (hosts.length === 0) {
    throw new Error("Could not resolve any future lunar occurrence.");
  }
  return { hosts, displayDates, timezone };
}

export function scheduleToHostParams(
  schedule: ReminderSchedule,
  config: PluginConfig,
): { host: HostParams; hosts: HostParams[]; display: string } {
  const normalized = normalizeConfig(config);
  if (schedule.kind === "once") {
    const delayMs = resolveOnceDelayMs(schedule);
    if (delayMs !== undefined) {
      if (delayMs < normalized.minDelayMinutes * 60_000) {
        throw new Error(
          `One-shot reminders must be at least ${normalized.minDelayMinutes} minute(s) in the future.`,
        );
      }
      const host = { delayMs, deleteAfterRun: true };
      return { host, hosts: [host], display: `${formatDurationMs(delayMs)} from now` };
    }
    if (!schedule.at) {
      throw new Error("One-shot reminders need at, delayMinutes, delaySeconds, or duration.");
    }
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`Invalid reminder datetime "${schedule.at}".`);
    }
    const minAt = Date.now() + normalized.minDelayMinutes * 60_000;
    if (at.getTime() < minAt) {
      throw new Error(
        `One-shot reminders must be at least ${normalized.minDelayMinutes} minute(s) in the future.`,
      );
    }
    const host = { at, deleteAfterRun: true };
    return { host, hosts: [host], display: at.toISOString() };
  }

  const tz = schedule.timezone?.trim() || normalized.defaultTimezone;
  if (schedule.kind === "interval") {
    const intervalMs = resolveIntervalMs(schedule);
    if (intervalMs < 60_000) {
      throw new Error("Interval reminders must be at least 1 minute apart.");
    }
    const host = {
      every: formatCliDurationMs(intervalMs),
      deleteAfterRun: false,
    };
    return { host, hosts: [host], display: `every ${formatDurationMs(intervalMs)}` };
  }

  const { hour, minute } = parseClockTime(schedule.time);
  if (schedule.kind === "daily") {
    const host = { cron: `${minute} ${hour} * * *`, tz, deleteAfterRun: false };
    return { host, hosts: [host], display: `every day at ${schedule.time} (${tz})` };
  }
  if (schedule.kind === "weekdays") {
    const host = { cron: `${minute} ${hour} * * 1-5`, tz, deleteAfterRun: false };
    return { host, hosts: [host], display: `weekdays at ${schedule.time} (${tz})` };
  }
  if (schedule.kind === "weekly") {
    const host = { cron: `${minute} ${hour} * * ${schedule.dayOfWeek}`, tz, deleteAfterRun: false };
    return { host, hosts: [host], display: `weekly on day ${schedule.dayOfWeek} at ${schedule.time} (${tz})` };
  }
  if (schedule.kind === "monthly") {
    const host = { cron: `${minute} ${hour} ${schedule.dayOfMonth} * *`, tz, deleteAfterRun: false };
    return { host, hosts: [host], display: `monthly on day ${schedule.dayOfMonth} at ${schedule.time} (${tz})` };
  }
  if (schedule.kind === "yearly") {
    const host = { cron: `${minute} ${hour} ${schedule.dayOfMonth} ${schedule.month} *`, tz, deleteAfterRun: false };
    return { host, hosts: [host], display: `yearly on ${schedule.month}-${schedule.dayOfMonth} at ${schedule.time} (${tz})` };
  }
  if (schedule.kind === "lunarOnce") {
    const lunar = lunarOnceHost(schedule, config);
    return {
      host: lunar.host,
      hosts: [lunar.host],
      display: `lunar once on ${schedule.lunarMonth}-${schedule.lunarDay} at ${schedule.time} (${lunar.timezone}); scheduled ${lunar.displayDate}`,
    };
  }
  const lunar = lunarYearlyHosts(schedule, config);
  return {
    host: lunar.hosts[0],
    hosts: lunar.hosts,
    display: `lunar yearly on ${schedule.lunarMonth}-${schedule.lunarDay} at ${schedule.time} (${lunar.timezone}); scheduled ${lunar.displayDates.length} occurrence(s): ${lunar.displayDates.slice(0, 3).join(", ")}${lunar.displayDates.length > 3 ? ", ..." : ""}`,
  };
}

function truncateTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").slice(0, 80) || "Reminder";
}

function buildReminderMessage(title: string, message: string) {
  return [
    `Reminder: ${truncateTitle(title)}`,
    "",
    "This scheduled turn was created through restricted_reminders for the current chat user only.",
    "Complete the reminder task and reply with the useful result. Do not mention internal tool or scheduler details unless they are necessary.",
    "",
    message.trim(),
  ].join("\n");
}

function resolveOpenClawCli(config: PluginConfig) {
  const configured = normalizeConfig(config).openclawCommand;
  if (configured) {
    return { command: configured, prefixArgs: [] as string[] };
  }
  const entry = process.argv[1];
  if (entry?.includes("openclaw") && entry.endsWith(".js")) {
    return { command: process.execPath, prefixArgs: [entry] };
  }
  return { command: "openclaw", prefixArgs: [] as string[] };
}

async function runOpenClawCli(config: PluginConfig, args: string[]) {
  const cli = resolveOpenClawCli(config);
  const { stdout } = await execFileAsync(cli.command, [...cli.prefixArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

function parseCronAddJson(stdout: string) {
  const parsed = JSON.parse(stdout) as { id?: string; job?: { id?: string } };
  const id = parsed.id ?? parsed.job?.id;
  if (!id) {
    throw new Error("OpenClaw CLI did not return a cron job id.");
  }
  return id;
}

async function addReminderViaCli(
  params: { title: string; message: string; schedule: ReminderSchedule },
  config: PluginConfig,
  identity: Identity,
  host: HostParams,
) {
  const args = [
    "cron",
    "add",
    "--json",
    "--session-key",
    identity.sessionKey,
    "--name",
    `RR ${truncateTitle(params.title)}`,
    "--message",
    buildReminderMessage(params.title, params.message),
    "--announce",
    "--channel",
    "last",
    "--light-context",
    "--timeout-seconds",
    "600",
  ];
  if (identity.agentId) {
    args.push("--agent", identity.agentId);
  }
  if (host.every) {
    args.push("--every", host.every, "--keep-after-run");
    if (host.tz) {
      args.push("--tz", host.tz);
    }
  } else if (host.delayMs !== undefined) {
    args.push("--at", `+${formatCliDurationMs(host.delayMs)}`, "--delete-after-run");
  } else if (host.at) {
    args.push("--at", host.at.toISOString(), "--delete-after-run");
  } else if (host.cron) {
    args.push("--cron", host.cron, "--keep-after-run", "--exact");
    if (host.tz) {
      args.push("--tz", host.tz);
    }
  } else {
    throw new Error("Unsupported reminder schedule.");
  }
  return parseCronAddJson(await runOpenClawCli(config, args));
}

async function addReminderHost(
  params: { title: string; message: string; schedule: ReminderSchedule },
  config: PluginConfig,
  api: SchedulerApi,
  identity: Identity,
  host: HostParams,
  tag: string,
) {
  if (!host.every && api.session.workflow.scheduleSessionTurn) {
    const scheduled = await api.session.workflow.scheduleSessionTurn({
      sessionKey: identity.sessionKey,
      agentId: identity.agentId,
      message: buildReminderMessage(params.title, params.message),
      deliveryMode: "announce",
      name: `RR ${tag.replace(/^rr_/, "")} ${truncateTitle(params.title)}`,
      tag,
      ...host,
    });
    if (scheduled?.id) {
      return scheduled.id;
    }
  }
  return addReminderViaCli(params, config, identity, host);
}

function formatRecord(record: ReminderRecord) {
  return `- ${record.id} · ${record.title} · ${record.displaySchedule}`;
}

async function addReminder(
  params: { title: string; message: string; schedule: ReminderSchedule },
  config: PluginConfig,
  api: SchedulerApi,
  identity: Identity,
) {
  const store = await readStore();
  const activeForUser = store.reminders.filter(
    (record) => record.userKey === identity.userKey && record.status === "active",
  );
  const normalized = normalizeConfig(config);
  if (activeForUser.length >= normalized.maxRemindersPerUser) {
    throw new Error(
      `You already have ${activeForUser.length} active reminder(s). Remove one before adding another.`,
    );
  }

  const id = randomUUID().slice(0, 8);
  const tag = `rr_${id}`;
  const { hosts, display } = scheduleToHostParams(params.schedule, config);
  const schedulerJobIds: string[] = [];
  for (const host of hosts) {
    schedulerJobIds.push(await addReminderHost(params, config, api, identity, host, tag));
  }

  if (schedulerJobIds.length === 0) {
    throw new Error("OpenClaw scheduler did not return a job id.");
  }

  const now = new Date().toISOString();
  const record: ReminderRecord = {
    id,
    userKey: identity.userKey,
    channel: identity.channel,
    accountId: identity.accountId,
    senderId: identity.senderId,
    sessionKey: identity.sessionKey,
    sessionId: identity.sessionId,
    tag,
    schedulerJobId: schedulerJobIds[0],
    schedulerJobIds,
    title: truncateTitle(params.title),
    message: params.message.trim(),
    schedule: params.schedule,
    displaySchedule: display,
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
  store.reminders.push(record);
  await writeStore(store);
  return record;
}

async function removeReminder(
  idOrTitle: string,
  config: PluginConfig,
  api: SchedulerApi,
  identity: Identity,
) {
  const store = await readStore();
  const query = idOrTitle.trim().toLowerCase();
  const candidates = store.reminders.filter(
    (record) =>
      record.userKey === identity.userKey &&
      record.status === "active" &&
      (record.id.toLowerCase() === query || record.title.toLowerCase().includes(query)),
  );

  if (candidates.length === 0) {
    return { removed: [], ambiguous: false };
  }
  if (candidates.length > 1) {
    return { removed: [], ambiguous: true, candidates };
  }
  const [record] = candidates;
  if (api.session.workflow.unscheduleSessionTurnsByTag) {
    await api.session.workflow.unscheduleSessionTurnsByTag({
      sessionKey: record.sessionKey,
      tag: record.tag,
    });
  } else if (record.schedulerJobIds?.length || record.schedulerJobId) {
    for (const jobId of record.schedulerJobIds ?? [record.schedulerJobId!]) {
      await runOpenClawCli(config, ["cron", "rm", jobId, "--json"]);
    }
  } else {
    throw new Error("OpenClaw did not expose reminder removal and no cron job id is stored.");
  }
  record.status = "cancelled";
  record.updatedAt = new Date().toISOString();
  await writeStore(store);
  return { removed: [record], ambiguous: false };
}

async function listReminders(identity: Identity) {
  const store = await readStore();
  return store.reminders
    .filter((record) => record.userKey === identity.userKey && record.status === "active")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export default defineToolPlugin({
  id: PLUGIN_ID,
  name: "Restricted Reminders",
  description:
    "Let chat users create, list, and remove only their own scheduled reminders without exposing cron, gateway, or nodes.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "restricted_reminders_add",
      label: "Add Restricted Reminder",
      description:
        "Create a reminder for the current chat sender only. Use this instead of cron for user reminder or scheduled review requests in WeChat, Feishu, DingTalk, or LightClawBot. Do not ask for or pass channel/user ids.",
      parameters: addSchema,
      factory({ api, config, toolContext }) {
        if (!shouldExposeReminderTools(toolContext, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_add",
          label: "Add Restricted Reminder",
          description:
            "Create a reminder for the current chat sender only. Use once.at for concrete solar times such as next Monday 09:58, once.duration for relative requests such as 2 days 3 hours 4 minutes 5 seconds later, interval.duration for every-N-duration requests, daily/weekdays/weekly/monthly/yearly for solar recurring requests, lunarOnce for one-time Chinese lunar date requests, and lunarYearly for Chinese lunar yearly requests. For daily 22:30 requests, use schedule.kind=daily and time=22:30; if today's time has passed, the recurring schedule naturally starts at the next future occurrence.",
          parameters: addSchema,
          async execute(_toolCallId: string, params: { title: string; message: string; schedule: ReminderSchedule }) {
            try {
              const identity = requireAllowedIdentity(toolContext, config);
              const record = await addReminder(params, config, api, identity);
              return textResult(`已创建提醒 ${record.id}：${record.title}，时间：${record.displaySchedule}。`, record);
            } catch (error) {
              return textResult(`创建提醒失败：${error instanceof Error ? error.message : String(error)}`);
            }
          },
        };
      },
    }),
    tool({
      name: "restricted_reminders_list",
      label: "List Restricted Reminders",
      description:
        "List active reminders owned by the current chat sender. Never lists reminders for other users.",
      parameters: Type.Object({}),
      factory({ config, toolContext }) {
        if (!shouldExposeReminderTools(toolContext, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_list",
          label: "List Restricted Reminders",
          description: "List active reminders owned by the current chat sender only.",
          parameters: Type.Object({}),
          async execute() {
            try {
              const identity = requireAllowedIdentity(toolContext, config);
              const reminders = await listReminders(identity);
              if (reminders.length === 0) {
                return textResult("你当前没有活动提醒。");
              }
              return textResult(`你的活动提醒：\n${reminders.map(formatRecord).join("\n")}`, reminders);
            } catch (error) {
              return textResult(`查看提醒失败：${error instanceof Error ? error.message : String(error)}`);
            }
          },
        };
      },
    }),
    tool({
      name: "restricted_reminders_remove",
      label: "Remove Restricted Reminder",
      description:
        "Remove one active reminder owned by the current chat sender by id or title. Never removes reminders for other users.",
      parameters: removeSchema,
      factory({ api, config, toolContext }) {
        if (!shouldExposeReminderTools(toolContext, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_remove",
          label: "Remove Restricted Reminder",
          description: "Remove one active reminder owned by the current chat sender only.",
          parameters: removeSchema,
          async execute(_toolCallId: string, params: { idOrTitle: string }) {
            try {
              const identity = requireAllowedIdentity(toolContext, config);
              const result = await removeReminder(params.idOrTitle, config, api, identity);
              if (result.ambiguous) {
                return textResult(
                  `匹配到多个提醒，请用 id 指定：\n${result.candidates?.map(formatRecord).join("\n")}`,
                );
              }
              if (result.removed.length === 0) {
                return textResult("没有找到属于你的匹配提醒。");
              }
              return textResult(`已取消提醒：${result.removed[0].id} · ${result.removed[0].title}`);
            } catch (error) {
              return textResult(`取消提醒失败：${error instanceof Error ? error.message : String(error)}`);
            }
          },
        };
      },
    }),
  ],
});

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

const PLUGIN_ID = "restricted-reminders";
const execFileAsync = promisify(execFile);
const DEFAULT_ALLOWED_CHANNELS = [
  "feishu",
  "openclaw-weixin",
  "dingtalk",
  "lightclawbot",
];

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
      minimum: 0,
      maximum: 1440,
      description: "Minimum delay for one-shot reminders.",
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
  openclawCommand?: string;
};

type ReminderSchedule =
  | { kind: "once"; at?: string; delayMinutes?: number }
  | { kind: "daily"; time: string; timezone?: string }
  | { kind: "weekdays"; time: string; timezone?: string }
  | { kind: "weekly"; dayOfWeek: number; time: string; timezone?: string };

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
        description: "Delay from now, in minutes.",
      }),
    ),
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
      config.allowedChannels?.filter((entry) => entry.trim()) ??
      DEFAULT_ALLOWED_CHANNELS,
    defaultTimezone: config.defaultTimezone?.trim() || "Asia/Shanghai",
    maxRemindersPerUser: config.maxRemindersPerUser ?? 20,
    minDelayMinutes: config.minDelayMinutes ?? 5,
    openclawCommand: config.openclawCommand?.trim() || undefined,
  };
}

function resolveIdentity(ctx: OpenClawPluginToolContext): Identity | null {
  const channel = ctx.messageChannel?.trim();
  const senderId = ctx.requesterSenderId?.trim();
  const sessionKey = ctx.sessionKey?.trim();
  if (!channel || !senderId || !sessionKey) {
    return null;
  }
  const accountId = ctx.agentAccountId?.trim() || undefined;
  const userKey = [channel, accountId ?? "default", senderId].join("|");
  return {
    userKey,
    channel,
    accountId,
    senderId,
    sessionKey,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
  };
}

function isAllowedIdentity(identity: Identity | null, config: PluginConfig) {
  if (!identity) {
    return false;
  }
  return normalizeConfig(config).allowedChannels.includes(identity.channel);
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

export function scheduleToHostParams(
  schedule: ReminderSchedule,
  config: PluginConfig,
): { host: { at?: Date; delayMs?: number; cron?: string; tz?: string; deleteAfterRun?: boolean }; display: string } {
  const normalized = normalizeConfig(config);
  if (schedule.kind === "once") {
    if (schedule.delayMinutes !== undefined) {
      if (schedule.delayMinutes < normalized.minDelayMinutes) {
        throw new Error(
          `One-shot reminders must be at least ${normalized.minDelayMinutes} minute(s) in the future.`,
        );
      }
      return {
        host: {
          delayMs: Math.round(schedule.delayMinutes * 60_000),
          deleteAfterRun: true,
        },
        display: `${schedule.delayMinutes} minute(s) from now`,
      };
    }
    if (!schedule.at) {
      throw new Error("One-shot reminders need either at or delayMinutes.");
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
    return {
      host: { at, deleteAfterRun: true },
      display: at.toISOString(),
    };
  }

  const tz = schedule.timezone?.trim() || normalized.defaultTimezone;
  const { hour, minute } = parseClockTime(schedule.time);
  if (schedule.kind === "daily") {
    return {
      host: { cron: `${minute} ${hour} * * *`, tz, deleteAfterRun: false },
      display: `every day at ${schedule.time} (${tz})`,
    };
  }
  if (schedule.kind === "weekdays") {
    return {
      host: { cron: `${minute} ${hour} * * 1-5`, tz, deleteAfterRun: false },
      display: `weekdays at ${schedule.time} (${tz})`,
    };
  }
  return {
    host: { cron: `${minute} ${hour} * * ${schedule.dayOfWeek}`, tz, deleteAfterRun: false },
    display: `weekly on day ${schedule.dayOfWeek} at ${schedule.time} (${tz})`,
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
  host: { at?: Date; delayMs?: number; cron?: string; tz?: string; deleteAfterRun?: boolean },
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
  if (host.delayMs !== undefined) {
    args.push("--at", `+${Math.ceil(host.delayMs / 60_000)}m`, "--delete-after-run");
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
  const { host, display } = scheduleToHostParams(params.schedule, config);
  const schedulerJobId = api.session.workflow.scheduleSessionTurn
    ? (
        await api.session.workflow.scheduleSessionTurn({
          sessionKey: identity.sessionKey,
          agentId: identity.agentId,
          message: buildReminderMessage(params.title, params.message),
          deliveryMode: "announce",
          name: `RR ${id} ${truncateTitle(params.title)}`,
          tag,
          ...host,
        })
      )?.id
    : await addReminderViaCli(params, config, identity, host);

  if (!schedulerJobId) {
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
    schedulerJobId,
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
  } else if (record.schedulerJobId) {
    await runOpenClawCli(config, ["cron", "rm", record.schedulerJobId, "--json"]);
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
        const identity = resolveIdentity(toolContext);
        if (!identity || !isAllowedIdentity(identity, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_add",
          label: "Add Restricted Reminder",
          description:
            "Create a reminder for the current chat sender only. For daily 22:30 requests, use schedule.kind=daily and time=22:30; if today's time has passed, the recurring schedule naturally starts at the next future occurrence.",
          parameters: addSchema,
          async execute(_toolCallId: string, params: { title: string; message: string; schedule: ReminderSchedule }) {
            try {
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
        const identity = resolveIdentity(toolContext);
        if (!identity || !isAllowedIdentity(identity, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_list",
          label: "List Restricted Reminders",
          description: "List active reminders owned by the current chat sender only.",
          parameters: Type.Object({}),
          async execute() {
            const reminders = await listReminders(identity);
            if (reminders.length === 0) {
              return textResult("你当前没有活动提醒。");
            }
            return textResult(`你的活动提醒：\n${reminders.map(formatRecord).join("\n")}`, reminders);
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
        const identity = resolveIdentity(toolContext);
        if (!identity || !isAllowedIdentity(identity, config)) {
          return null;
        }
        return {
          name: "restricted_reminders_remove",
          label: "Remove Restricted Reminder",
          description: "Remove one active reminder owned by the current chat sender only.",
          parameters: removeSchema,
          async execute(_toolCallId: string, params: { idOrTitle: string }) {
            try {
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

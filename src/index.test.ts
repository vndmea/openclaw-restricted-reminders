import { describe, expect, it } from "vitest";
import entry, { cronRemoveArgs, resolveIdentity, scheduleToHostParams, shouldExposeReminderTools } from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("restricted-reminders", () => {
  it("declares restricted reminder tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "restricted_reminders_add",
      "restricted_reminders_list",
      "restricted_reminders_remove",
    ]);
  });

  it("converts daily reminders to cron without same-day backfill semantics", () => {
    const result = scheduleToHostParams(
      { kind: "daily", time: "22:30" },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.host).toMatchObject({
      cron: "30 22 * * *",
      tz: "Asia/Shanghai",
      deleteAfterRun: false,
    });
  });

  it("converts interval reminders to cron", () => {
    const result = scheduleToHostParams(
      { kind: "interval", everyMinutes: 2 },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.host).toMatchObject({
      every: "120s",
      deleteAfterRun: false,
    });
    expect(result.host).not.toHaveProperty("tz");
  });

  it("uses OpenClaw cron rm without unsupported json flags", () => {
    expect(cronRemoveArgs("job-1")).toEqual(["cron", "rm", "job-1"]);
  });

  it("allows one-shot reminders starting at one minute by default", () => {
    const result = scheduleToHostParams({ kind: "once", delayMinutes: 1 }, {});
    expect(result.host).toMatchObject({
      delayMs: 60_000,
      deleteAfterRun: true,
    });
  });

  it("converts mixed relative durations to precise millisecond delays", () => {
    const result = scheduleToHostParams(
      { kind: "once", duration: { days: 2, hours: 3, minutes: 4, seconds: 5 } },
      {},
    );
    expect(result.host.delayMs).toBe(183_845_000);
    expect(result.display).toBe("2d3h4m5s from now");
  });

  it("rejects one-shot reminders shorter than the minimum", () => {
    expect(() =>
      scheduleToHostParams({ kind: "once", duration: { seconds: 30 } }, {}),
    ).toThrow(/at least 1/);
  });

  it("converts monthly reminders to cron", () => {
    const result = scheduleToHostParams(
      { kind: "monthly", dayOfMonth: 22, time: "09:58" },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.host).toMatchObject({
      cron: "58 9 22 * *",
      tz: "Asia/Shanghai",
    });
  });

  it("converts yearly reminders to cron", () => {
    const result = scheduleToHostParams(
      { kind: "yearly", month: 3, dayOfMonth: 22, time: "09:58" },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.host).toMatchObject({
      cron: "58 9 22 3 *",
      tz: "Asia/Shanghai",
    });
  });

  it("pre-schedules lunar yearly reminders as concrete future solar dates", () => {
    const result = scheduleToHostParams(
      { kind: "lunarYearly", lunarMonth: 3, lunarDay: 22, time: "09:58", yearsAhead: 2 },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.hosts.length).toBeGreaterThan(0);
    expect(result.hosts[0]).toMatchObject({ deleteAfterRun: true });
    expect(result.display).toContain("lunar yearly on 3-22");
  });

  it("converts one-time lunar reminders to the next future solar date", () => {
    const result = scheduleToHostParams(
      { kind: "lunarOnce", lunarMonth: 6, lunarDay: 4, time: "23:59" },
      { defaultTimezone: "Asia/Shanghai" },
    );
    expect(result.host.at?.toISOString()).toBe("2026-07-17T15:59:00.000Z");
    expect(result.display).toContain("lunar once on 6-4");
    expect(result.display).toContain("2026-07-17 23:59");
  });

  it("resolves channel aliases from OpenClaw chat context variants", () => {
    const identity = resolveIdentity({
      messageProvider: "weixin",
      requesterSenderId: "wx-user",
      sessionKey: "agent:main:openclaw-weixin:wx-user",
    } as any);
    expect(identity).toMatchObject({
      channel: "weixin",
      senderId: "wx-user",
      sessionKey: "agent:main:openclaw-weixin:wx-user",
    });
    expect(shouldExposeReminderTools({
      currentChannelProvider: "weixin",
      requesterSenderId: "wx-user",
      sessionKey: "agent:main:openclaw-weixin:wx-user",
    } as any, { allowedChannels: ["openclaw-weixin"] })).toBe(true);
  });

  it("keeps tools visible before sender identity is attached", () => {
    expect(shouldExposeReminderTools({
      currentChannelProvider: "openclaw-weixin",
    } as any, { allowedChannels: ["openclaw-weixin"] })).toBe(true);
  });

  it("derives the sender from OpenClaw channel session keys", () => {
    const identity = resolveIdentity({
      toolContext: { currentChannelProvider: "openclaw-weixin" },
      sessionKey: "agent:main:openclaw-weixin:o9cq803_C5cZw3tdRWmG3avNjwzc@im.wechat",
    } as any);
    expect(identity).toMatchObject({
      channel: "openclaw-weixin",
      senderId: "o9cq803_C5cZw3tdRWmG3avNjwzc@im.wechat",
      sessionKey: "agent:main:openclaw-weixin:o9cq803_C5cZw3tdRWmG3avNjwzc@im.wechat",
    });
  });
});

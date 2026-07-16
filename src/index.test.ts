import { describe, expect, it } from "vitest";
import entry, { scheduleToHostParams } from "./index.js";
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
      tz: "Asia/Shanghai",
      deleteAfterRun: false,
    });
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
});

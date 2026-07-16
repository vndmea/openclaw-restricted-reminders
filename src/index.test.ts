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
      cron: "*/2 * * * *",
      tz: "Asia/Shanghai",
      deleteAfterRun: false,
    });
  });

  it("rejects too-soon one-shot reminders", () => {
    expect(() =>
      scheduleToHostParams({ kind: "once", delayMinutes: 1 }, { minDelayMinutes: 5 }),
    ).toThrow(/at least 5/);
  });
});

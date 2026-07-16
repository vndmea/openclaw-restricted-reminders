# OpenClaw Restricted Reminders

English | [简体中文](https://github.com/vndmea/openclaw-restricted-reminders/blob/main/README.zh-CN.md)

Restricted per-user reminder tools for OpenClaw chat channels.

## What is it?

OpenClaw Restricted Reminders lets an agent create, list, and remove reminders for the current chat sender only. It is designed for WeChat, Feishu, DingTalk, and LightClawBot deployments where ordinary users should be able to manage their own reminders without receiving the powerful core `cron`, `gateway`, or `nodes` tools.

The plugin keeps the security boundary small:

- Tool calls never accept another user's channel id, recipient id, or sender id.
- Reminder ownership is derived from OpenClaw's trusted inbound tool context.
- Listing and removal only operate on reminders owned by the current sender.
- Actual scheduling is delegated to OpenClaw's scheduler or cron backend.

## Tools

- `restricted_reminders_add`
- `restricted_reminders_list`
- `restricted_reminders_remove`

The tools are registered only when OpenClaw provides a trusted inbound channel, sender id, and session key.

## Supported Schedules

| Request shape | Structured schedule |
| --- | --- |
| "Remind me next Monday at 09:58" | `once.at` |
| "Remind me in 2 days 3 hours 4 minutes 5 seconds" | `once.duration` |
| "Remind me in 90 seconds" | `once.delaySeconds` |
| "Remind me every 2 minutes" | `interval.everyMinutes` or `interval.duration` |
| "Remind me every 2 hours 30 minutes" | `interval.duration` |
| "Remind me every day at 22:30" | `daily` |
| "Remind me every weekday at 09:00" | `weekdays` |
| "Remind me every Monday at 09:58" | `weekly` |
| "Remind me on the 22nd of every month at 09:58" | `monthly` |
| "Remind me every year on March 22 at 09:58" | `yearly` |
| "Remind me every lunar March 22 at 09:58" | `lunarYearly` |

For lunar yearly reminders, the plugin uses [`lunar-javascript`](https://github.com/6tail/lunar-javascript) to convert future lunar dates into concrete solar dates, then pre-schedules one-shot jobs for the configured number of future years.

## Build

```bash
npm install
npm test
npm run build
npm run plugin:validate
```

## Install

From the OpenClaw host:

```bash
openclaw plugins install ./openclaw-restricted-reminders
openclaw gateway restart
```

Then ask through an allowed channel:

```text
Remind me next Monday at 09:58 to grab coupons
Remind me in 2 days 3 hours 4 minutes 5 seconds to check the server
Remind me every 2 minutes to report the time
What reminders do I have?
Cancel the coupon reminder
```

## Configuration

Optional config:

```json
{
  "plugins": {
    "restricted-reminders": {
      "allowedChannels": ["feishu", "openclaw-weixin", "dingtalk", "lightclawbot"],
      "defaultTimezone": "Asia/Shanghai",
      "maxRemindersPerUser": 20,
      "minDelayMinutes": 1,
      "lunarYearsAhead": 10
    }
  }
}
```

OpenClaw config shape can vary by installation path. Use `openclaw config patch` or the OpenClaw control UI to apply plugin config in your environment.

# OpenClaw Restricted Reminders

Restricted per-user reminder tools for OpenClaw chat channels.

The plugin lets an agent create, list, and remove reminders for the current
chat sender only. It is intended for public or semi-public WeChat, Feishu,
DingTalk, and LightClawBot access where ordinary users should not receive the
core `cron`, `gateway`, or `nodes` tools.

## Tools

- `restricted_reminders_add`
- `restricted_reminders_list`
- `restricted_reminders_remove`

The tools are registered only when OpenClaw provides a trusted inbound channel,
sender id, and session key. Tool arguments never accept `channel`, `to`, or
another user's id.

## Supported Schedules

- one-shot reminders by absolute ISO datetime or delay in minutes
- interval reminders such as every 2 minutes
- daily reminders such as `22:30`
- weekday reminders
- weekly reminders

For “每天 22:30”, the plugin creates cron `30 22 * * *` in the configured
timezone. If today's 22:30 has already passed, OpenClaw naturally waits for the
next future occurrence.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

## Install

From the OpenClaw host:

```bash
openclaw plugins install ./openclaw-restricted-reminders
openclaw gateway restart
```

Then ask through an allowed channel:

```text
每天22:30提醒我复盘股票
我有哪些提醒？
取消股票复盘提醒
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
      "minDelayMinutes": 5
    }
  }
}
```

OpenClaw config shape can vary by installation path; use `openclaw config
patch` or the OpenClaw control UI to apply plugin config in your environment.

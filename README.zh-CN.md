# OpenClaw Restricted Reminders

[English](https://github.com/vndmea/openclaw-restricted-reminders/blob/master/README.md) | 简体中文

面向 OpenClaw 聊天渠道的受限提醒插件。

## 这是什么？

OpenClaw Restricted Reminders 允许 agent 为当前聊天用户创建、查看和取消提醒。它适合微信、飞书、钉钉和 LightClawBot 这类公开或半公开入口：普通用户可以管理自己的提醒，但不会拿到高权限的 `cron`、`gateway`、`nodes` 工具。

插件的权限边界很小：

- 工具参数不接受其他用户的 channel id、recipient id 或 sender id。
- 提醒归属来自 OpenClaw 可信的入站工具上下文。
- 查看和取消提醒时，只操作当前发送者自己的提醒。
- 真正的调度执行交给 OpenClaw scheduler 或 cron 后端。

## 工具

- `restricted_reminders_add`
- `restricted_reminders_list`
- `restricted_reminders_remove`

只有当 OpenClaw 提供可信的入站渠道、发送者 id 和 session key 时，这些工具才会注册。

## 支持的提醒类型

| 用户说法 | 结构化 schedule |
| --- | --- |
| “下周一 09:58 提醒我抢券” | `once.at` |
| “2天3小时4分5秒后提醒我检查服务器” | `once.duration` |
| “90秒后提醒我” | `once.delaySeconds` |
| “每隔2分钟提醒我报时” | `interval.everyMinutes` 或 `interval.duration` |
| “每隔2小时30分钟提醒我” | `interval.duration` |
| “每天22:30提醒我复盘股票” | `daily` |
| “每个工作日09:00提醒我开会” | `weekdays` |
| “每周一09:58提醒我抢券” | `weekly` |
| “每月22号09:58提醒我” | `monthly` |
| “每年3月22日09:58提醒我” | `yearly` |
| “每年农历三月二十二09:58提醒我” | `lunarYearly` |

农历年重复不能直接用普通 cron 表达，因为每年对应的公历日期不同。插件使用 [`lunar-javascript`](https://github.com/6tail/lunar-javascript) 把未来若干年的农历日期换算成具体公历日期，再预创建一次性提醒。

## 构建

```bash
npm install
npm test
npm run build
npm run plugin:validate
```

## 安装

在 OpenClaw 所在机器执行：

```bash
openclaw plugins install ./openclaw-restricted-reminders
openclaw gateway restart
```

然后可以通过允许的聊天渠道发送：

```text
下周一09:58提醒我抢券
2天3小时4分5秒后提醒我检查服务器
每隔2分钟给我报时
我有哪些提醒？
取消抢券提醒
```

## 配置

可选配置：

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

不同 OpenClaw 安装的配置结构可能不同。可以使用 `openclaw config patch` 或 OpenClaw 控制台写入插件配置。

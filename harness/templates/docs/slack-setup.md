# Slack Setup Guide

Each Collabot bot that connects to Slack needs its own Slack App. This guide walks through creating one.

## 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App** > **From scratch**
3. Name it after your bot (e.g. "Greg") and select your workspace
4. Click **Create App**

## 2. Enable Socket Mode

1. In your app settings, go to **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** to ON
3. You'll be prompted to create an **App-Level Token**:
   - Name it something like `collabot-socket`
   - Add the scope `connections:write`
   - Click **Generate**
4. Copy the `xapp-...` token — this is your **App Token**

## 3. Add Bot Scopes

1. Go to **OAuth & Permissions** (left sidebar)
2. Under **Scopes > Bot Token Scopes**, add:
   - `chat:write` — send messages
   - `im:history` — read DM history
   - `im:read` — receive DM events
   - `app_mentions:read` — respond to @mentions

## 4. Subscribe to Events

1. Go to **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:
   - `message.im` — direct messages to the bot
   - `app_mention` — @mentions in channels

## 5. Install to Workspace

1. Go to **Install App** (left sidebar)
2. Click **Install to Workspace** and authorize
3. Copy the `xoxb-...` token — this is your **Bot Token**

## 6. Configure Collabot

In `collabot setup`, enter the tokens when prompted. Or manually edit:

**.env:**
```
GREG_APP_TOKEN=xapp-1-...
GREG_BOT_TOKEN=xoxb-...
```

**config.toml:**
```toml
[slack.bots.greg]
botTokenEnv = "GREG_BOT_TOKEN"
appTokenEnv = "GREG_APP_TOKEN"
```

The env var prefix is derived from the bot's data name (e.g. `greg` -> `GREG_`).

## Multiple Bots

Repeat steps 1-5 for each bot. Each bot needs its own Slack App with its own tokens. This gives each bot a separate identity in Slack (name, avatar, etc.).

## Troubleshooting

- **Bot not responding?** Check that Socket Mode is enabled and the App Token has `connections:write` scope.
- **"Missing scopes" error?** Reinstall the app after adding new scopes.
- **Messages going to wrong bot?** Make sure each bot has a unique Slack App. Sharing tokens between bots causes routing issues.

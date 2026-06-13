# Pebble AI Chat

Minimal Pebble Time 2/Core Devices watchapp for chatting with an AI assistant through OpenRouter.

## What It Does

- Press `SELECT` on the watch to dictate a prompt.
- PebbleKit JS sends the prompt to OpenRouter from the Pebble phone app.
- The model and OpenRouter API key are configured from the Pebble phone app settings gear.
- If the assistant returns a timeline request, the phone app pushes a Pebble timeline pin for the current user.

## Configure

Open the app settings in the Pebble phone app and set:

- `OpenRouter API Key`: your OpenRouter key, usually `sk-or-v1-...`.
- `Model`: any OpenRouter model id, for example `openai/gpt-4o-mini`.

## Build

```sh
npm install
pebble build
```

This workspace has also been verified with a local venv-installed CLI:

```sh
.venv/bin/pebble build
```

The built app is `build/pebble-app.pbw`.

## Timeline Notes

Pebble timeline pins require a valid timeline token for this app/user. Rebble's docs note that timeline tokens may require the app UUID to be known by the appstore/developer backend. If the token is unavailable, the watch will show `No timeline token`.

The assistant is instructed to return JSON with a `timeline` object only when the user asks to add, schedule, remind, or put something on the timeline. The phone app converts that to a generic timeline pin and pushes it with `X-User-Token`.

#!/bin/bash
# Keeps exactly one feedback-bot-listener running. Cron calls this every
# minute; if the listener died (stream drop, deploy restart, reboot) it comes
# back within 60 s. Deliberately dumber than a service manager.
set -u
cd "$(dirname "$0")"
mkdir -p .feedback-bot
if pgrep -f "feedback-bot-listener.mjs" > /dev/null 2>&1; then
  exit 0
fi
nohup node feedback-bot-listener.mjs >> .feedback-bot/listener.log 2>&1 &
echo "$(date -Is) listener (re)started" >> .feedback-bot/listener.log

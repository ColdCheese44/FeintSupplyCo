Write-Host "Registering Jarvis cron jobs with OpenClaw..."

openclaw cron add `
  --name "jarvis-heartbeat" `
  --every "6h" `
  --message "run jarvis heartbeat" `
  --description "Jarvis trend research and listing generation" `
  --announce

openclaw cron add `
  --name "jarvis-orderwatch" `
  --every "10m" `
  --message "run jarvis orderwatch" `
  --description "Jarvis order fulfillment and tracking sync" `
  --announce

Write-Host "Cron jobs registered."
Write-Host "View schedule: openclaw cron list"
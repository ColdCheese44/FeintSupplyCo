Write-Host "Registering FeintSupplyCo cron jobs with OpenClaw..."

openclaw cron add `
  --name "fsc-heartbeat" `
  --every "6h" `
  --message "run feintsupply heartbeat" `
  --description "FeintSupplyCo trend research and listing generation" `
  --announce

openclaw cron add `
  --name "feintsupply-orderwatch" `
  --every "10m" `
  --message "run feintsupply orderwatch" `
  --description "FeintSupplyCo order fulfillment and tracking sync" `
  --announce

Write-Host "Cron jobs registered."
Write-Host "View schedule: openclaw cron list"
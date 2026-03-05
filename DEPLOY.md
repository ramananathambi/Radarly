# Radarly — Deployment Guide (Hostinger)

## Prerequisites
- Hostinger Business hosting plan (includes Node.js support)
- GitHub account (Hostinger deploys from Git)
- Twilio account with WhatsApp sandbox or approved number
- Supabase project (already set up)

## Step 1: Push to GitHub

```bash
git add .
git commit -m "Initial release — Radarly v1.0"
git remote add origin https://github.com/YOUR_USERNAME/radarly.git
git push -u origin main
```

## Step 2: Configure Hostinger

1. Log in to Hostinger hPanel
2. Go to **Websites** > your domain > **Advanced** > **Node.js**
3. Set:
   - **Node.js version**: 18.x or 20.x
   - **Application root**: `/` (project root)
   - **Application startup file**: `server/index.js`
   - **Port**: leave as auto-assigned (Hostinger manages this)
4. Click **Create**

## Step 3: Connect GitHub

1. In hPanel, go to **Git** section
2. Connect your GitHub repo
3. Set branch: `main`
4. Deploy

## Step 4: Set Environment Variables

In Hostinger hPanel > Node.js > Environment Variables, add:

```
SUPABASE_URL=https://tzksxheopspuwdtmwjcx.supabase.co
SUPABASE_ANON_KEY=<your_anon_key>
SUPABASE_SERVICE_KEY=<your_service_role_key>
TWILIO_ACCOUNT_SID=<your_twilio_sid>
TWILIO_AUTH_TOKEN=<your_twilio_auth_token>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_SMS_FROM=+1XXXXXXXXXX
ADMIN_PASSWORD=<strong_random_password>
PORT=3000
APP_NAME=Radarly
APP_URL=https://yourdomain.com
DEV_MODE=false
```

**Important**: Set `DEV_MODE=false` in production to enable real Twilio messaging.

## Step 5: Install Dependencies

SSH into Hostinger or use the built-in terminal:
```bash
npm install --production
```

## Step 6: Seed Stocks (One-time)

```bash
node scripts/seedStocks.js
```

This will try NSE + BSE APIs first (works from Indian servers). If they fail, use:
```bash
node scripts/seedStocks.js --static
```

## Step 7: Set Up Twilio Webhook

1. In Twilio Console, go to your WhatsApp Sandbox settings
2. Set the **When a message comes in** webhook to:
   ```
   https://yourdomain.com/api/webhooks/twilio
   ```
   Method: POST

## Step 8: Verify

1. Visit `https://yourdomain.com` — landing page should load
2. Visit `https://yourdomain.com/admin.html` — log in with your admin password
3. Click **Run Data Fetch** to pull NSE+BSE corporate actions
4. Check server logs for fetch results

## Cron Schedule (Automatic)

The app runs these cron jobs automatically (IST timezone):
- **8:00 AM** — Fetch corporate actions from NSE + BSE
- **9:30 AM** — Run alert engine (sends T-2 dividend alerts)

## Troubleshooting

- **NSE 403 error**: NSE blocks non-Indian IPs. Hostinger's Indian servers should work.
- **Port in use**: Hostinger manages port assignment. The app uses `process.env.PORT`.
- **Twilio not sending**: Ensure `DEV_MODE=false` and Twilio credentials are correct.
- **OTP not arriving**: Check Twilio SMS logs in the Twilio Console.
